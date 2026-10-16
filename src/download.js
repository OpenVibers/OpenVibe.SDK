'use strict';
/**
 * openvibe-sdk/download — OpenVibe.Download, a person's drive at openvibe.download, from a script or the
 * `openvibe-download` command: list it, make folders, upload in parts, delete, and `sync()`, which keeps a folder on
 * this computer backed up in the drive. Server-side (Node): it reads files from disk.
 *
 * It authenticates with a sync key the person makes at https://openvibe.download/sync (`ovdl_…`, shown once; it acts
 * on their drive and nothing else), or with the person's own Network token.
 *
 *   const dl = createDownloadClient({ key: process.env.OPENVIBE_DOWNLOAD_KEY });
 *   await dl.files.list({ folderId })                  // → { folder_id, folders, files, usage }
 *   const folderId = await dl.folders.ensurePath('Backups/laptop');
 *   await dl.upload({ path: './notes.txt', folderId });  // → the file (or { data, name } for bytes)
 *   const report = await dl.sync('/home/kim/Documents', { to: 'Backups/laptop' });
 *   // report: { uploaded, skipped, replaced, deleted, failed, bytes, errors }
 *
 * sync(dir, { to, delete, dryRun, exclude, onEvent }): walks `dir` (symbolic links are not followed), mirrors its
 * folders under `to`, and uploads a file whose drive copy is missing or differs (size, or sha256 when the drive has
 * one). A changed file is uploaded again and the older copy deleted. With `delete: true` drive files under `to` that
 * have no local copy are removed (a folder whose local folder is gone is emptied); without it a backup only adds. `exclude` lists names to skip
 * (exact, or `*.ext`); `.DS_Store`, `Thumbs.db` and `desktop.ini` are always skipped. A rate limit (429) is waited
 * out and retried; the drive's daily file cap or storage quota stops the sync with the reason.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('./core/client');
const { isOpenVibeError } = require('./core/errors');

const DEFAULT_URL = 'https://openvibe.download';
const ALWAYS_SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const STOPPING = new Set(['file.daily_limit', 'file.quota', 'sync_key.invalid', 'token.required']);
const CONTENT_TYPES = {
    '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function contentTypeOf(name) {
    return CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
    });
    return hash.digest('hex');
}

function excluded(name, patterns) {
    if (ALWAYS_SKIP.has(name)) return true;
    return patterns.some((p) => (p.startsWith('*.') ? name.toLowerCase().endsWith(p.slice(1).toLowerCase()) : name === p));
}

function createDownloadClient(options = {}) {
    const baseUrl = String(options.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
    const token = options.key || options.token;
    if (!token) throw new TypeError('createDownloadClient: pass { key } (a sync key from openvibe.download/sync) or { token }');
    const client = options.client || createClient({ token, baseUrls: { download: baseUrl }, retries: 2 });
    const wait = options.sleep || sleep;

    /** One call, a rate limit waited out (Retry-After, else a minute) up to `tries` times. */
    async function call(opts, tries = 6) {
        for (let attempt = 1; ; attempt++) {
            try {
                return await client.request({ service: 'download', baseUrl, ...opts });
            } catch (err) {
                if (!isOpenVibeError(err) || err.status !== 429 || attempt >= tries || (err.code && err.code !== 'rate_limited')) throw err;
                const seconds = Number(err.problem && (err.problem.retry_after_seconds || err.problem.retry_after)) || 60;
                await wait(Math.min(300, Math.max(1, seconds)) * 1000);
            }
        }
    }
    const json = async (opts) => (await call(opts)).data;

    const files = {
        /** One folder's files and subfolders (or the root's), up to 200 a page; `before` pages back. */
        list: ({ folderId = null, limit = 200, before = null } = {}) => json({
            path: '/api/v1/files', query: { folder_id: folderId || undefined, limit, before: before || undefined },
        }),
        /** Every file in one folder, all pages. */
        async all({ folderId = null } = {}) {
            const out = [];
            let before = null;
            for (;;) {
                const page = await files.list({ folderId, before });
                out.push(...page.files);
                if (page.files.length < 200) return out;
                before = page.files[page.files.length - 1].id;
            }
        },
        get: (id) => json({ path: `/api/v1/files/${encodeURIComponent(id)}` }),
        remove: (id) => call({ method: 'DELETE', path: `/api/v1/files/${encodeURIComponent(id)}`, idempotencyKey: false }),
    };

    const folders = {
        list: async () => (await json({ path: '/api/v1/folders' })).folders,
        create: async (name, parentId = null) => (await json({
            method: 'POST', path: '/api/v1/folders', json: { name, parent_id: parentId }, idempotencyKey: false,
        })).folder,
        /** The id of the folder at `drivePath` ('Backups/laptop'), making the missing ones; null for the root. */
        async ensurePath(drivePath, { known = null } = {}) {
            const parts = String(drivePath || '').split('/').map((p) => p.trim()).filter(Boolean);
            const all = known || await folders.list();
            let parent = null;
            for (const name of parts) {
                let found = all.find((f) => (f.parent_id || null) === parent && f.name.toLowerCase() === name.toLowerCase());
                if (!found) {
                    found = await folders.create(name, parent);
                    all.push(found);
                }
                parent = found.id;
            }
            return parent;
        },
    };

    /** Upload one file: { path } from disk, or { data, name }; → the drive's file. */
    async function upload({ path: file = null, data = null, name = null, folderId = null, contentType = null } = {}) {
        const fileName = name || (file ? path.basename(file) : null);
        if (!fileName) throw new TypeError('upload: pass { path } or { data, name }');
        const size = file ? (await fsp.stat(file)).size : Buffer.byteLength(data);
        if (size < 1) throw new TypeError(`upload: ${fileName} is empty (the drive keeps files of at least one byte)`);
        const started = await json({
            method: 'POST', path: '/api/v1/files', idempotencyKey: false,
            json: { name: fileName, size, content_type: contentType || contentTypeOf(fileName), folder_id: folderId },
        });
        const up = started.upload;
        const handle = file ? await fsp.open(file, 'r') : null;
        try {
            for (let n = 1; n <= up.parts_expected; n++) {
                const start = (n - 1) * up.part_size;
                const length = Math.min(up.part_size, size - start);
                let body;
                if (handle) {
                    body = Buffer.alloc(length);
                    await handle.read(body, 0, length, start);
                } else {
                    body = Buffer.from(data).subarray(start, start + length);
                }
                await call({ method: 'PUT', path: `/api/v1/uploads/${up.id}/parts/${n}`, body, headers: { 'content-type': 'application/octet-stream' } });
            }
        } catch (err) {
            await call({ method: 'DELETE', path: `/api/v1/uploads/${up.id}`, idempotencyKey: false }).catch(() => {});
            throw err;
        } finally {
            if (handle) await handle.close();
        }
        return (await json({ method: 'POST', path: `/api/v1/uploads/${up.id}/complete`, json: {}, idempotencyKey: false })).file;
    }

    const usage = async () => (await json({ path: '/api/v1/usage' })).usage;

    /** Keep `dir` backed up under the drive folder `to` (see the module comment). */
    async function sync(dir, { to = '', delete: prune = false, dryRun = false, exclude = [], onEvent = () => {} } = {}) {
        const root = path.resolve(dir);
        const stat = await fsp.stat(root);
        if (!stat.isDirectory()) throw new TypeError(`sync: ${root} is not a folder`);
        const report = { uploaded: 0, replaced: 0, skipped: 0, deleted: 0, failed: 0, bytes: 0, errors: [] };
        const allFolders = await folders.list();
        const emit = (e) => { try { onEvent(e); } catch { /* the caller's printer must not stop the sync */ } };
        let stopped = null;

        const childFolder = (parentId, name) => allFolders.find((f) => (f.parent_id || null) === parentId && f.name.toLowerCase() === name.toLowerCase());

        async function walk(localDir, folderId, rel) {
            if (stopped) return;
            const entries = (await fsp.readdir(localDir, { withFileTypes: true }))
                .filter((e) => !excluded(e.name, exclude))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            const remote = folderId === undefined ? [] : await files.all({ folderId });
            const byName = new Map();
            for (const f of remote) {
                const list = byName.get(f.name) || [];
                list.push(f);
                byName.set(f.name, list);
            }
            const seenFiles = new Set();
            const seenDirs = new Set();
            for (const e of entries) {
                if (stopped) return;
                const local = path.join(localDir, e.name);
                const relPath = rel ? `${rel}/${e.name}` : e.name;
                if (e.isSymbolicLink()) { report.skipped++; emit({ type: 'skip', path: relPath, reason: 'symbolic link' }); continue; }
                if (e.isDirectory()) {
                    seenDirs.add(e.name.toLowerCase());
                    let sub = folderId === undefined ? undefined : childFolder(folderId, e.name);
                    if (!sub && !dryRun) {
                        sub = await folders.create(e.name, folderId);
                        allFolders.push(sub);
                        emit({ type: 'folder', path: relPath });
                    }
                    await walk(local, sub ? sub.id : undefined, relPath);
                    continue;
                }
                if (!e.isFile()) continue;
                seenFiles.add(e.name);
                const st = await fsp.stat(local);
                if (st.size < 1) { report.skipped++; emit({ type: 'skip', path: relPath, reason: 'empty' }); continue; }
                const copies = (byName.get(e.name) || []).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
                const current = copies[0] || null;
                let same = false;
                if (current && Number(current.size) === st.size) {
                    same = current.sha256 ? current.sha256 === await sha256File(local) : true;
                }
                if (same) { report.skipped++; emit({ type: 'same', path: relPath }); continue; }
                emit({ type: current ? 'replace' : 'upload', path: relPath, size: st.size, dryRun });
                if (dryRun) { report[current ? 'replaced' : 'uploaded']++; report.bytes += st.size; continue; }
                try {
                    await upload({ path: local, folderId });
                    report[current ? 'replaced' : 'uploaded']++;
                    report.bytes += st.size;
                    for (const old of copies) await files.remove(old.id);
                } catch (err) {
                    report.failed++;
                    const code = isOpenVibeError(err) ? err.code : null;
                    report.errors.push({ path: relPath, code, message: String(err.detail || err.message || err) });
                    emit({ type: 'error', path: relPath, code, message: String(err.detail || err.message || err) });
                    if (code && STOPPING.has(code)) stopped = { code, message: String(err.detail || err.message) };
                }
            }
            if (!prune || folderId === undefined) return;
            for (const [name, list] of byName) {
                if (seenFiles.has(name)) continue;
                for (const f of list) {
                    emit({ type: 'delete', path: rel ? `${rel}/${name}` : name, dryRun });
                    if (!dryRun) await files.remove(f.id);
                    report.deleted++;
                }
            }
            // A drive folder whose local folder is gone: its files go (the folder itself stays, empty).
            for (const sub of allFolders.filter((f) => (f.parent_id || null) === folderId && !seenDirs.has(f.name.toLowerCase()))) {
                await empty(sub.id, rel ? `${rel}/${sub.name}` : sub.name);
            }
        }

        async function empty(folderId, rel) {
            for (const f of await files.all({ folderId })) {
                emit({ type: 'delete', path: `${rel}/${f.name}`, dryRun });
                if (!dryRun) await files.remove(f.id);
                report.deleted++;
            }
            for (const sub of allFolders.filter((f) => f.parent_id === folderId)) await empty(sub.id, `${rel}/${sub.name}`);
        }

        const top = dryRun
            ? (await (async () => {
                let parent = null;
                for (const name of String(to).split('/').map((p) => p.trim()).filter(Boolean)) {
                    const f = childFolder(parent, name);
                    if (!f) return undefined;
                    parent = f.id;
                }
                return parent;
            })())
            : await folders.ensurePath(to, { known: allFolders });
        await walk(root, top, '');
        if (stopped) report.stopped = stopped;
        return report;
    }

    return { files, folders, upload, usage, sync };
}

module.exports = { createDownloadClient, contentTypeOf };
