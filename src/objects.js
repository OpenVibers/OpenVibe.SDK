'use strict';
/**
 * createObjectsClient(): OpenVibe.Media's object API v2 (/api/v2/:app/objects) and its jobs
 * (/api/v2/:app/jobs). Exported from openvibe-sdk/media. Browser-safe code (fetch, Blob, Web Crypto),
 * but the credentials it needs belong on a server.
 *
 *   const objects = createObjectsClient({ app: 'demo', tokenClient: createServiceTokenClient({ clientId, clientSecret }) });
 *   const obj = await objects.upload(bytes, { kind: 'file', mimeType: 'image/png', filename: 'a.png' });
 *   const { url } = await objects.signedUrl(obj.id, { ttl: 300 });
 *
 * Base URL: `baseUrl`, or discovered from the Network's platform descriptor (/.well-known/openvibe).
 * The descriptor gives an origin only for services that are live; when Media has none (not
 * registered, or only a planned origin) the client throws sdk.service_unavailable instead of guessing.
 *
 * Credentials (one of): `tokenClient` (createServiceTokenClient: a service or developer-app principal
 * with media.object.upload / media.object.read for namespace `app`; a developer app uses its project
 * id as `app`), `apiKey` (the app's Media API key), or a `client` from createClient() that carries its
 * own. `actingUserId` (app key only) acts for one of the app's users (X-OV-User-Id); `subject` names
 * the owner (X-OV-Subject: usr_…).
 *
 * upload() picks single or multipart by size: single PUT to Media's presigned URL up to
 * `multipartThreshold` (default 64 MiB), multipart above it (or when Media says the object is too
 * large for one part). Parts go up `concurrency` at a time with their sha256; failed parts are retried
 * and, after the round, the session is read back and whatever is missing is sent again (resumable
 * after a dropped connection; `resume()` continues a session from another process). The whole
 * object's sha256 is sent for Media to verify when the data is at most `hashMaxBytes` (256 MiB).
 */
const { createClient } = require('./core/client');
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { paginate } = require('./core/paginate');

const MIB = 1024 * 1024;
const enc = encodeURIComponent;
const TERMINAL_JOB = new Set(['succeeded', 'failed', 'cancelled']);

function toBody(data) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('objects.upload: pass a Blob/File, ArrayBuffer, typed array (Buffer) or string');
}
const sizeOf = (body) => (typeof Blob !== 'undefined' && body instanceof Blob ? body.size : body.byteLength);
const slice = (body, start, end) => (typeof Blob !== 'undefined' && body instanceof Blob ? body.slice(start, end) : body.subarray(start, end));

async function sha256Hex(part) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) return null;
    const bytes = typeof Blob !== 'undefined' && part instanceof Blob ? new Uint8Array(await part.arrayBuffer()) : part;
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createObjectsClient({
    app, baseUrl, tokenClient, apiKey, client, network, fetch: fetchImpl, discoveryUrl,
    actingUserId, subject, multipartThreshold = 64 * MIB, partSize = 16 * MIB, concurrency = 4,
    hashMaxBytes = 256 * MIB, resumeRounds = 3, timeoutMs, partTimeoutMs = 10 * 60 * 1000,
} = {}) {
    if (!app) throw new TypeError('createObjectsClient: app (the tenant: an app id, or a developer project id prj_…) is required');
    if (!client && !tokenClient && !apiKey) throw new TypeError('createObjectsClient: pass tokenClient, apiKey or client');
    const http = client || createClient({
        network, discoveryUrl, fetch: fetchImpl, ...(tokenClient ? { tokenProvider: tokenClient } : {}), ...(timeoutMs ? { timeoutMs } : {}),
    });
    const O = `/api/v2/${enc(app)}/objects`;
    const J = `/api/v2/${enc(app)}/jobs`;
    let base = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;

    /** Media's origin: the given baseUrl, or the descriptor's live origin for `media`. */
    async function resolveBase() {
        if (base) return base;
        const d = await http.discover();
        const s = (d.services || []).find((x) => x && x.id === 'media');
        if (!s || !s.origin) {
            const why = !s ? 'Media is not in the platform descriptor' : `Media has no live origin in the platform descriptor (status ${s.status || 'unknown'}${s.planned_origin ? `, planned at ${s.planned_origin}` : ''})`;
            throw new OpenVibeError({ code: 'sdk.service_unavailable', message: `${why}; pass baseUrl to use a Media you know is up` });
        }
        base = String(s.origin).replace(/\/+$/, '');
        return base;
    }

    const headersFor = (per = {}) => {
        const h = { ...(per.headers || {}) };
        const acting = per.actingUserId !== undefined ? per.actingUserId : actingUserId;
        if (acting != null) h['X-OV-User-Id'] = String(acting);
        const subj = per.subject !== undefined ? per.subject : subject;
        if (subj) h['X-OV-Subject'] = String(subj);
        return h;
    };
    const call = async (opts, per = {}) => http.request({
        service: 'media', audience: 'openvibe.media', baseUrl: await resolveBase(), ...(apiKey ? { token: apiKey } : {}),
        ...opts, headers: headersFor({ ...per, headers: opts.headers }),
    });
    const json = async (opts, per) => (await call(opts, per)).data;
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    /** A presigned Media URL: no Authorization header (the token is in the URL). */
    const presigned = (url, opts) => http.request({ url, auth: false, ...opts });

    // ── Upload ───────────────────────────────────────────────

    async function init(body, per) {
        return json({ method: 'POST', path: O, json: body, idempotencyKey: false }, per);
    }

    /**
     * How one multipart session is driven: through its presigned URLs (a fresh upload) or, for
     * resume(), with our own credential on the same routes (Media accepts either).
     */
    function sessionIo(session, { objectId, credential = false } = {}) {
        const path = `${O}/${enc(objectId)}/multipart/${enc(session.upload_id)}`;
        return {
            partSize: session.part_size,
            partsExpected: session.parts_expected,
            status: (signal) => (credential ? json({ path, signal }) : presigned(session.status_url, { method: 'GET', signal }).then((r) => r.data)),
            putPart: (n, part, headers, signal) => (credential
                ? call({ method: 'PUT', path: `${path}/parts/${n}`, body: part, headers, signal, timeoutMs: partTimeoutMs, deadlineMs: partTimeoutMs * 3 })
                : presigned(session.part_url_template.replace('{part_number}', String(n)), { method: 'PUT', body: part, headers, signal, timeoutMs: partTimeoutMs, deadlineMs: partTimeoutMs * 3 })),
            complete: (body, signal) => (credential
                ? json({ method: 'POST', path: `${path}/complete`, json: body, signal, idempotent: true, timeoutMs: partTimeoutMs, deadlineMs: partTimeoutMs * 2 })
                : presigned(session.complete_url, { method: 'POST', json: body, signal, idempotent: true, timeoutMs: partTimeoutMs, deadlineMs: partTimeoutMs * 2 }).then((r) => r.data)),
        };
    }

    async function putParts(io, body, todo, { signal, onProgress, total, done, shaOf }) {
        const failed = [];
        let next = 0;
        const worker = async () => {
            while (next < todo.length) {
                const n = todo[next++];
                const start = (n - 1) * io.partSize;
                const part = slice(body, start, Math.min(start + io.partSize, total));
                const sha = await shaOf(n);
                try {
                    await io.putPart(n, part, { 'Content-Type': 'application/octet-stream', ...(sha ? { 'X-Content-SHA256': sha } : {}) }, signal);
                    done.bytes += sizeOf(part);
                    if (onProgress) onProgress({ uploadedBytes: done.bytes, totalBytes: total, part: n });
                } catch (err) {
                    if (err && err.code === 'sdk.aborted') throw err;
                    failed.push({ part: n, error: err });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
        return failed;
    }

    /**
     * Send what a session is missing (round after round, reading it back each time), then complete it.
     * Parts Media already holds (a resumed session) are checked against our bytes; any that differ are
     * sent again. The complete call names every part's sha256 as computed here.
     */
    async function finishMultipart(objectId, uploadId, io, body, { signal, onProgress, contentHash, total }) {
        const mine = new Map();
        const shaOf = async (n) => {
            if (!mine.has(n)) {
                const start = (n - 1) * io.partSize;
                mine.set(n, await sha256Hex(slice(body, start, Math.min(start + io.partSize, total))));
            }
            return mine.get(n);
        };
        const done = { bytes: 0 };
        let status = await io.status(signal);
        if (status.total_size != null && status.total_size !== total) {
            throw new OpenVibeError({ code: 'sdk.upload_mismatch', message: `objects.upload: the session expects ${status.total_size} bytes, the data has ${total}` });
        }
        const stale = [];
        for (const p of status.parts || []) {
            const ours = await shaOf(p.part_number);
            if (ours && p.sha256 && ours !== p.sha256) stale.push(p.part_number);
            else done.bytes += p.size_bytes;
        }
        let todo = [...(status.missing || []), ...stale].sort((a, b) => a - b);
        let lastError = null;
        for (let round = 0; round <= resumeRounds && todo.length; round++) {
            const failed = await putParts(io, body, todo, { signal, onProgress, total, done, shaOf });
            if (failed.length) lastError = failed[0].error;
            status = await io.status(signal);
            todo = status.missing || [];
        }
        if (todo.length) {
            const err = new OpenVibeError({
                code: 'sdk.upload_incomplete', cause: lastError || undefined,
                message: `objects.upload: ${todo.length} part(s) could not be sent; call resume(err.resume, data) to continue`,
            });
            err.resume = { objectId, uploadId, missing: todo };
            throw err;
        }
        const parts = [];
        for (let n = 1; n <= io.partsExpected; n++) {
            const sha = await shaOf(n);
            if (sha) parts.push({ part_number: n, sha256: sha });
        }
        return io.complete({ ...(contentHash ? { content_hash: contentHash } : {}), ...(parts.length ? { parts } : {}) }, signal);
    }

    /**
     * upload(data, { kind = 'file', visibility = 'private', mimeType | contentType, filename, metadata,
     *                contentHash (hex | false), userId, subject, actingUserId, multipart ('auto' | true | false),
     *                partSize, onProgress({ uploadedBytes, totalBytes, part }), signal, uploadTtl })
     *   -> the object (Media's public shape, lifecycle_status 'ready')
     */
    async function upload(data, opts = {}) {
        const {
            kind = 'file', visibility = 'private', filename, metadata, userId, multipart = 'auto', signal, onProgress, uploadTtl,
        } = opts;
        const mime = opts.mimeType || opts.contentType || (typeof Blob !== 'undefined' && data instanceof Blob && data.type) || null;
        const body = toBody(data);
        const total = sizeOf(body);
        if (!total) throw new TypeError('objects.upload: nothing to upload (0 bytes)');
        const per = { actingUserId: opts.actingUserId, subject: opts.subject };
        let contentHash = opts.contentHash === false ? null : opts.contentHash || null;
        if (!contentHash && opts.contentHash !== false && total <= hashMaxBytes) contentHash = await sha256Hex(body);
        const wantParts = multipart === true || (multipart === 'auto' && total > multipartThreshold);
        const req = {
            kind, visibility, size_bytes: total, ...(mime ? { mime_type: mime } : {}), ...(filename ? { filename } : {}),
            ...(metadata ? { metadata } : {}), ...(contentHash ? { content_hash: contentHash } : {}), ...(userId != null ? { user_id: userId } : {}),
            ...(uploadTtl ? { upload_ttl: uploadTtl } : {}),
        };
        let created;
        try {
            created = await init(wantParts ? { ...req, multipart: true, part_size: opts.partSize || partSize } : req, per);
        } catch (err) {
            // Media's single-part limit is lower than our threshold: go multipart.
            if (!(multipart === 'auto' && !wantParts && isOpenVibeError(err) && err.status === 413 && err.code === 'media.object.too_large')) throw err;
            created = await init({ ...req, multipart: true, part_size: opts.partSize || partSize }, per);
        }
        const up = created.upload || {};
        if (up.multipart) {
            return finishMultipart(created.id, up.multipart.upload_id, sessionIo(up.multipart, { objectId: created.id }), body, { signal, onProgress, contentHash, total });
        }
        await presigned(up.url, {
            method: 'PUT', body, signal, timeoutMs: partTimeoutMs, deadlineMs: partTimeoutMs * 2,
            headers: { 'Content-Type': mime || 'application/octet-stream' },
        });
        if (onProgress) onProgress({ uploadedBytes: total, totalBytes: total });
        return json({ method: 'POST', path: `${O}/${enc(created.id)}/complete`, json: contentHash ? { content_hash: contentHash } : {}, idempotent: true }, per);
    }

    /**
     * Continue a multipart upload, e.g. from another process after a crash: reads the session with
     * this client's credential, sends the parts it is missing from `data` (the same bytes), completes
     * it. `ref` is err.resume from upload(), or { objectId, uploadId }.
     */
    async function resume({ objectId, uploadId }, data, { signal, onProgress, contentHash } = {}) {
        const body = toBody(data);
        const total = sizeOf(body);
        const session = await json({ path: `${O}/${enc(objectId)}/multipart/${enc(uploadId)}`, signal });
        if (session.status !== 'active') throw new OpenVibeError({ code: 'sdk.upload_incomplete', message: `objects.resume: the upload is ${session.status}` });
        const hash = contentHash === false ? null : contentHash || (total <= hashMaxBytes ? await sha256Hex(body) : null);
        return finishMultipart(objectId, uploadId, sessionIo(session, { objectId, credential: true }), body, { signal, onProgress, contentHash: hash, total });
    }

    // ── Reads, links, delete ─────────────────────────────────

    /** Object metadata (locations, lifecycle, public_url …), or null. Accepts med_… ids and legacy refs. */
    const get = (id) => orNull(json({ path: `${O}/${enc(id)}` }));

    /**
     * signedUrl(id, { ttl }) -> { url, expires_at, public }. Private objects get a signed link valid
     * `ttl` seconds (30-3600); public and unlisted ones their public URL (expires_at null).
     */
    const signedUrl = (id, { ttl } = {}) => json({ path: `${O}/${enc(id)}/download`, query: { format: 'json', ttl } });

    /** Soft delete. true when deleted (or already), false when there is no such object. */
    async function del(id) {
        try { await call({ method: 'DELETE', path: `${O}/${enc(id)}` }); return true; } catch (err) {
            if (isOpenVibeError(err) && err.status === 404) return false;
            throw err;
        }
    }

    /** One page: { objects, next_cursor, limit }. */
    const list = ({ kind, visibility, status, owner, userId, limit, cursor, includeDeleted } = {}) => json({
        path: O, query: { kind, visibility, status, owner, user_id: userId, limit, cursor, include_deleted: includeDeleted ? 1 : undefined },
    });

    /** Async iterator over every matching object, newest first. */
    const iterate = (q = {}) => paginate(async (cursor) => {
        const page = await list({ ...q, cursor: cursor || undefined });
        return { items: page.objects || [], next: page.next_cursor };
    }, { cursor: null });

    // ── Jobs ─────────────────────────────────────────────────

    const jobs = {
        /** create({ type, objectId, params, idempotencyKey, maxAttempts }) -> job (a repeat of the same key answers the same job). */
        async create({ type, objectId, params, idempotencyKey, maxAttempts } = {}) {
            if (!type) throw new TypeError('jobs.create: type is required');
            const res = await json({
                method: 'POST', path: J, idempotencyKey: idempotencyKey || undefined,
                json: { type, ...(objectId ? { object_id: objectId } : {}), ...(params ? { params } : {}), ...(maxAttempts ? { max_attempts: maxAttempts } : {}) },
            });
            return res.job;
        },
        get: async (id) => { const r = await orNull(json({ path: `${J}/${enc(id)}` })); return r ? r.job : null; },
        /** { jobs, next_cursor, limit } */
        list: ({ status, type, objectId, limit, cursor } = {}) => json({ path: J, query: { status, type, object_id: objectId, limit, cursor } }),
        /** A proposal (status proposed) -> queued. */
        approve: async (id) => (await json({ method: 'POST', path: `${J}/${enc(id)}/approve`, idempotent: true })).job,
        /** Cancel: proposed/queued at once; a running job reports cancel_requested until it stops. */
        cancel: async (id) => (await json({ method: 'POST', path: `${J}/${enc(id)}/cancel`, idempotent: true })).job,
        /** Poll until the job is succeeded, failed or cancelled (or timeoutMs passes: the job as it is then). */
        async wait(id, { intervalMs = 1000, timeoutMs: max = 10 * 60 * 1000, signal } = {}) {
            const end = Date.now() + max;
            for (;;) {
                const job = await jobs.get(id);
                if (!job || TERMINAL_JOB.has(job.status) || Date.now() >= end) return job;
                if (signal && signal.aborted) throw new OpenVibeError({ code: 'sdk.aborted', message: 'jobs.wait: aborted' });
                await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, end - Date.now()))));
            }
        },
    };

    return { app, baseUrl: resolveBase, upload, resume, get, signedUrl, delete: del, list, iterate, jobs, client: http };
}

module.exports = { createObjectsClient };
