'use strict';
// openvibe-sdk/download: OpenVibe.Download's drive API from a script, and sync() backups, against a small stand-in
// drive (the routes, the parts and the sha256 the real one keeps). Checks: folders mirrored, only new or changed files
// sent, a changed file replaced, --delete, a dry run that writes nothing, 429 waited out, the daily cap stopping the
// sync, and the openvibe-download command's exit codes.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDownloadClient } = require('../src/download');
const { main } = require('../bin/openvibe-download');

const KEY = `ovdl_${'k'.repeat(43)}`;

function startDrive({ dailyCap = 1000 } = {}) {
    const state = { folders: [], files: [], uploads: new Map(), seq: 0, uploadsToday: 0, throttleNext: false, requests: [] };
    const id = (p) => `${p}_${String(++state.seq).padStart(26, '0')}`;
    const send = (res, status, body) => {
        res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://drive.test');
            const body = Buffer.concat(chunks);
            state.requests.push(`${req.method} ${url.pathname}`);
            if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { code: 'sync_key.invalid', detail: 'bad key' });
            const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
            const p = url.pathname;
            if (req.method === 'GET' && p === '/api/v1/folders') return send(res, 200, { folders: state.folders });
            if (req.method === 'POST' && p === '/api/v1/folders') {
                const b = json();
                const f = { id: id('fld'), name: b.name, parent_id: b.parent_id || null, created_at: new Date().toISOString() };
                state.folders.push(f);
                return send(res, 201, { folder: f });
            }
            if (req.method === 'GET' && p === '/api/v1/files') {
                const folderId = url.searchParams.get('folder_id') || null;
                return send(res, 200, {
                    folder_id: folderId,
                    folders: state.folders.filter((f) => f.parent_id === folderId),
                    files: state.files.filter((f) => f.folder_id === folderId),
                    usage: { bytes_used: 0, bytes_limit: 1, files: state.files.length, uploads_today: state.uploadsToday },
                });
            }
            if (req.method === 'POST' && p === '/api/v1/files') {
                if (state.throttleNext) {
                    state.throttleNext = false;
                    return send(res, 429, { code: 'rate_limited', detail: 'slow down', retry_after_seconds: 1 });
                }
                if (state.uploadsToday >= dailyCap) return send(res, 429, { code: 'file.daily_limit', detail: 'You have uploaded enough files today.' });
                state.uploadsToday++;
                const b = json();
                const up = { id: id('upl'), name: b.name, size: b.size, folder_id: b.folder_id || null, part_size: 4, parts_expected: Math.ceil(b.size / 4), parts: [] };
                state.uploads.set(up.id, up);
                return send(res, 201, { upload: { id: up.id, part_size: up.part_size, parts_expected: up.parts_expected, missing: [] } });
            }
            let m = /^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(p);
            if (req.method === 'PUT' && m) {
                state.uploads.get(m[1]).parts[Number(m[2]) - 1] = body;
                return send(res, 200, { part: Number(m[2]), size: body.length });
            }
            m = /^\/api\/v1\/uploads\/([^/]+)\/complete$/.exec(p);
            if (req.method === 'POST' && m) {
                const up = state.uploads.get(m[1]);
                const data = Buffer.concat(up.parts);
                const file = { id: id('fil'), name: up.name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), folder_id: up.folder_id, created_at: new Date(Date.now() + state.seq).toISOString(), data };
                state.files.push(file);
                const { data: _d, ...wire } = file;
                return send(res, 201, { file: wire });
            }
            m = /^\/api\/v1\/files\/([^/]+)$/.exec(p);
            if (req.method === 'DELETE' && m) {
                state.files = state.files.filter((f) => f.id !== m[1]);
                return send(res, 204);
            }
            if (req.method === 'GET' && p === '/api/v1/usage') return send(res, 200, { usage: { bytes_used: 10, bytes_limit: 100, files: state.files.length, uploads_today: state.uploadsToday } });
            return send(res, 404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function tree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovdl-'));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
}

(async () => {
    const drive = await startDrive();
    const noWait = async () => {};
    const dl = createDownloadClient({ key: KEY, baseUrl: drive.url, sleep: noWait });
    const local = tree({ 'notes.txt': 'hello world', 'photos/cat.jpg': 'meow meow', 'photos/.DS_Store': 'x', 'empty.txt': '' });
    try {
        // A dry run writes nothing.
        const dry = await dl.sync(local, { to: 'Backups/laptop', dryRun: true });
        assert.deepStrictEqual([dry.uploaded, drive.state.files.length, drive.state.folders.length], [2, 0, 0], 'a dry run sends and makes nothing');

        // The first sync mirrors the folders and sends both files (the empty file and .DS_Store are skipped), and a
        // rate limit on the way is waited out.
        drive.state.throttleNext = true;
        const first = await dl.sync(local, { to: 'Backups/laptop' });
        assert.strictEqual(first.uploaded, 2, JSON.stringify(first));
        assert.strictEqual(first.failed, 0);
        const names = drive.state.folders.map((f) => f.name).sort();
        assert.deepStrictEqual(names, ['Backups', 'laptop', 'photos']);
        const cat = drive.state.files.find((f) => f.name === 'cat.jpg');
        assert.strictEqual(cat.data.toString(), 'meow meow', 'parts arrive in order');
        assert.ok(!drive.state.files.some((f) => f.name === '.DS_Store' || f.name === 'empty.txt'));

        // Unchanged: nothing sent. Changed: sent again and the older copy deleted.
        const again = await dl.sync(local, { to: 'Backups/laptop' });
        assert.deepStrictEqual([again.uploaded, again.replaced, again.skipped >= 2], [0, 0, true]);
        fs.writeFileSync(path.join(local, 'notes.txt'), 'hello there, world');
        const changed = await dl.sync(local, { to: 'Backups/laptop' });
        assert.strictEqual(changed.replaced, 1);
        const notes = drive.state.files.filter((f) => f.name === 'notes.txt');
        assert.strictEqual(notes.length, 1, 'the older copy is gone');
        assert.strictEqual(notes[0].data.toString(), 'hello there, world');

        // --delete removes drive files whose local copy is gone, including inside a vanished folder.
        fs.rmSync(path.join(local, 'photos'), { recursive: true });
        const kept = await dl.sync(local, { to: 'Backups/laptop' });
        assert.strictEqual(kept.deleted, 0, 'without --delete a backup only adds');
        const pruned = await dl.sync(local, { to: 'Backups/laptop', delete: true });
        assert.strictEqual(pruned.deleted, 1);
        assert.ok(!drive.state.files.some((f) => f.name === 'cat.jpg'));

        // The command: usage, ls, a missing key, a bad folder.
        const out = [];
        const err = [];
        const w = (arr) => ({ write: (s) => { arr.push(s); return true; } });
        const env = { OPENVIBE_DOWNLOAD_KEY: KEY, OPENVIBE_DOWNLOAD_URL: drive.url };
        assert.strictEqual(await main(['usage'], env, w(out), w(err)), 0);
        assert.match(out.join(''), /stored/);
        assert.strictEqual(await main(['ls', 'Backups/laptop'], env, w(out), w(err)), 0);
        assert.match(out.join(''), /notes\.txt/);
        assert.strictEqual(await main(['sync', local], env, w(out), w(err)), 2, 'sync needs --to');
        assert.strictEqual(await main(['usage'], {}, w(out), w(err)), 2, 'no key');
        assert.strictEqual(await main(['sync', local, '--to', 'B', '--bogus'], env, w(out), w(err)), 2);
    } finally {
        await drive.close();
    }

    // The drive's daily cap stops the sync with its reason, and the command exits 1.
    const capped = await startDrive({ dailyCap: 1 });
    try {
        const dir = tree({ 'a.txt': 'aaaa', 'b.txt': 'bbbb', 'c.txt': 'cccc' });
        const report = await createDownloadClient({ key: KEY, baseUrl: capped.url, sleep: noWait }).sync(dir, { to: 'B' });
        assert.strictEqual(report.uploaded, 1);
        assert.strictEqual(report.stopped && report.stopped.code, 'file.daily_limit');
        assert.strictEqual(report.failed, 1, 'it stops at the first refusal');
        const out = [];
        const code = await main(['sync', dir, '--to', 'B', '-q'], { OPENVIBE_DOWNLOAD_KEY: KEY, OPENVIBE_DOWNLOAD_URL: capped.url }, { write: (s) => out.push(s) }, { write: (s) => out.push(s) });
        assert.strictEqual(code, 1);
        assert.match(out.join(''), /Stopped: You have uploaded enough files today/);
    } finally {
        await capped.close();
    }
    assert.throws(() => createDownloadClient({}), /sync key/);
    console.log('download: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
