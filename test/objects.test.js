'use strict';
/**
 * createObjectsClient (openvibe-sdk/media) against a mock of Media's object API v2: discovery of the
 * Media origin from the platform descriptor (live origins only), single uploads through the presigned
 * URL, multipart uploads with per-part sha256 (automatic by size, and as a fallback when Media refuses
 * a single part), recovery from failed parts, resume() of a session another process started, get /
 * signedUrl / delete / list / iterate, jobs, and the credentials and headers each call carries.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createObjectsClient } = require('../src/media');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A small Media v2: objects, presigned single PUT, multipart sessions, download links, jobs. */
async function mockMedia({ singleMax = 1024 * 1024, failPart = null, descriptor = null } = {}) {
    const state = { objects: new Map(), sessions: new Map(), jobs: new Map(), n: 0, failures: 0 };
    let base = '';
    const srv = await stubServer(async (req, res, body) => {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        if (p === '/.well-known/openvibe') return send(res, 200, descriptor ? descriptor(base) : { contracts: { version: '0.30.0' }, services: [{ id: 'media', status: 'beta', origin: base }] });
        const m = /^\/api\/v2\/([^/]+)\/(objects|jobs)(?:\/([^/]+))?(?:\/(.+))?$/.exec(p);
        if (!m) return send(res, 404, {});
        const [, app, coll, id, rest] = m;
        const token = u.searchParams.get('token');
        const authed = !!req.headers.authorization;
        if (coll === 'jobs') {
            if (!authed) return problem(res, 401, 'token.missing', 'no');
            if (req.method === 'POST' && !id) {
                const b = JSON.parse(body);
                const key = req.headers['idempotency-key'];
                const prior = key && [...state.jobs.values()].find((j) => j.key === key);
                if (prior) return send(res, 200, { job: prior.pub }, { 'Idempotent-Replayed': 'true' });
                const job = { key, polls: 0, pub: { id: `mjob_${++state.n}`, app_id: app, type: b.type, object_id: b.object_id || null, params: b.params || {}, status: 'queued' } };
                state.jobs.set(job.pub.id, job);
                return send(res, 202, { job: job.pub });
            }
            const job = state.jobs.get(id);
            if (!id) return send(res, 200, { jobs: [...state.jobs.values()].map((j) => j.pub).filter((j) => !u.searchParams.get('status') || j.status === u.searchParams.get('status')), next_cursor: null });
            if (!job) return problem(res, 404, 'media.job.not_found', 'No such job');
            if (req.method === 'GET') { if (++job.polls >= 3 && job.pub.status === 'queued') job.pub.status = 'succeeded'; return send(res, 200, { job: job.pub }); }
            if (rest === 'approve') { job.pub.status = 'queued'; return send(res, 200, { job: job.pub }); }
            if (rest === 'cancel') { job.pub.status = 'cancelled'; return send(res, 200, { job: job.pub }); }
        }
        // ── objects ──
        if (req.method === 'POST' && !id) {
            if (!authed) return problem(res, 401, 'token.missing', 'no');
            const b = JSON.parse(body);
            if (!b.multipart && b.size_bytes > singleMax) return problem(res, 413, 'media.object.too_large', `Single-part uploads are limited to ${singleMax} bytes; send multipart: true for larger objects`);
            const oid = `med_${String(++state.n).padStart(26, '0')}`;
            const obj = { id: oid, app_id: app, kind: b.kind, visibility: b.visibility, size_bytes: b.size_bytes, mime_type: b.mime_type || null, lifecycle_status: 'uploading', expected: b.content_hash || null, bytes: null, init: b, headers: req.headers };
            state.objects.set(oid, obj);
            const out = { id: oid, object: pub(obj), upload: { complete_url: `${base}/api/v2/${app}/objects/${oid}/complete`, multipart_url: `${base}/api/v2/${app}/objects/${oid}/multipart` } };
            if (b.multipart) out.upload = { ...out.upload, method: 'multipart', url: null, multipart: newSession(obj, b.part_size) };
            else Object.assign(out.upload, { method: 'PUT', url: `${base}/api/v2/${app}/objects/${oid}/content?token=put-${oid}`, token: `put-${oid}` });
            return send(res, 201, out);
        }
        if (req.method === 'GET' && !id) {
            if (!authed) return problem(res, 401, 'token.missing', 'no');
            const all = [...state.objects.values()].filter((o) => o.lifecycle_status !== 'deleted').sort((a, b) => (a.id < b.id ? 1 : -1));
            const cursor = u.searchParams.get('cursor');
            const limit = Number(u.searchParams.get('limit') || 50);
            const from = cursor ? all.filter((o) => o.id < cursor) : all;
            const page = from.slice(0, limit);
            return send(res, 200, { objects: page.map(pub), next_cursor: from.length > limit ? page[page.length - 1].id : null, limit });
        }
        const obj = state.objects.get(id);
        if (!obj) return problem(res, 404, 'media.object.not_found', 'No such object in this namespace');
        if (rest === 'content' && req.method === 'PUT') {
            if (authed || token !== `put-${id}`) return problem(res, 401, 'media.upload_token.invalid', 'presigned only here');
            if (body.length !== obj.size_bytes) return problem(res, 400, 'media.object.size_mismatch', 'size');
            obj.bytes = body; obj.putType = req.headers['content-type'];
            return send(res, 200, { id, size_bytes: body.length, content_hash: sha(body) });
        }
        if (rest === 'complete') {
            if (!authed) return problem(res, 401, 'token.missing', 'no');
            const b = body.length ? JSON.parse(body) : {};
            if ((b.content_hash || obj.expected) && sha(obj.bytes) !== (b.content_hash || obj.expected)) return problem(res, 422, 'media.object.hash_mismatch', 'hash');
            obj.lifecycle_status = 'ready';
            return send(res, 200, pub(obj));
        }
        if (rest && rest.startsWith('multipart/')) {
            const [, uid, what, n] = rest.split('/');
            const s = state.sessions.get(uid);
            if (!s || s.objectId !== id) return problem(res, 404, 'media.upload.not_found', 'no');
            if (!authed && token !== s.token) return problem(res, 401, 'media.upload_token.invalid', 'no');
            s.calls.push({ method: req.method, what: what || 'status', authed, n: n && Number(n) });
            if (!what && req.method === 'GET') return send(res, 200, sessionPub(s));
            if (what === 'parts') {
                const k = Number(n);
                const want = k < s.parts_expected ? s.part_size : s.total_size - s.part_size * (s.parts_expected - 1);
                if (failPart && failPart(k, s)) { state.failures++; res.socket.destroy(); return; }
                if (body.length !== want) return problem(res, 400, 'media.upload.part_size_mismatch', 'size');
                if (req.headers['x-content-sha256'] && req.headers['x-content-sha256'] !== sha(body)) return problem(res, 400, 'media.upload.part_hash_mismatch', 'sha');
                s.parts.set(k, body);
                return send(res, 200, { part_number: k, size_bytes: body.length, sha256: sha(body) });
            }
            if (what === 'complete') {
                const b = JSON.parse(body || '{}');
                if (sessionPub(s).missing.length) return problem(res, 409, 'media.upload.parts_missing', 'missing');
                for (const c of b.parts || []) if (sha(s.parts.get(c.part_number)) !== c.sha256) return problem(res, 400, 'media.upload.part_hash_mismatch', `part ${c.part_number}`);
                obj.bytes = Buffer.concat([...s.parts.keys()].sort((x, y) => x - y).map((k) => s.parts.get(k)));
                s.completeBody = b;
                if (b.content_hash && b.content_hash !== sha(obj.bytes)) return problem(res, 422, 'media.object.hash_mismatch', 'hash');
                obj.lifecycle_status = 'ready';
                s.status = 'completed';
                return send(res, 200, pub(obj));
            }
        }
        if (!authed) return problem(res, 401, 'token.missing', 'no');
        if (rest === 'download') return send(res, 200, { url: `${base}/o/${id}?exp=1&sig=s&ttl=${u.searchParams.get('ttl')}`, expires_at: '2030-01-01T00:00:00.000Z', public: false, format: u.searchParams.get('format') });
        if (req.method === 'GET' && !rest) return send(res, 200, pub(obj));
        if (req.method === 'DELETE' && !rest) { obj.lifecycle_status = 'deleted'; return send(res, 200, pub(obj)); }
        return send(res, 404, {});
    });
    base = srv.url;
    function pub(o) { return { id: o.id, app_id: o.app_id, kind: o.kind, visibility: o.visibility, size_bytes: o.size_bytes, mime_type: o.mime_type, lifecycle_status: o.lifecycle_status, content_hash: o.bytes ? sha(o.bytes) : null }; }
    function newSession(obj, partSize) {
        const uid = `mup_${++state.n}`;
        const s = { upload_id: uid, objectId: obj.id, part_size: partSize, total_size: obj.size_bytes, parts_expected: Math.ceil(obj.size_bytes / partSize), token: `mp1.${uid}`, parts: new Map(), calls: [], status: 'active' };
        state.sessions.set(uid, s);
        const u = `${base}/api/v2/${obj.app_id}/objects/${obj.id}/multipart/${uid}`;
        return { ...sessionPub(s, false), token: s.token, part_url_template: `${u}/parts/{part_number}?token=${s.token}`, status_url: `${u}?token=${s.token}`, complete_url: `${u}/complete?token=${s.token}`, abort_url: `${u}?token=${s.token}` };
    }
    function sessionPub(s, withParts = true) {
        const out = { upload_id: s.upload_id, object_id: s.objectId, status: s.status, part_size: s.part_size, total_size: s.total_size, parts_expected: s.parts_expected };
        if (!withParts) return out;
        const parts = [...s.parts.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ part_number: k, size_bytes: b.length, sha256: sha(b) }));
        const missing = [];
        for (let k = 1; k <= s.parts_expected; k++) if (!s.parts.has(k)) missing.push(k);
        return { ...out, parts, missing };
    }
    return { srv, state, newSession };
}

const tokenClient = () => {
    const seen = [];
    return { seen, getToken: async (ctx) => { seen.push(ctx.audience); return 'svc-token'; }, invalidate() {} };
};

run([
    ['discovery: the descriptor gives Media\'s live origin; none (or a planned one) is an error, never a guess', async () => {
        const m = await mockMedia();
        const tc = tokenClient();
        const objects = createObjectsClient({ app: 'demo', tokenClient: tc, network: m.srv.url });
        assert.equal(await objects.baseUrl(), m.srv.url);
        const obj = await objects.upload('hi', { mimeType: 'text/plain' });
        assert.equal(obj.lifecycle_status, 'ready');
        assert.deepEqual([...new Set(tc.seen)], ['openvibe.media'], 'tokens are asked for audience openvibe.media');
        await m.srv.close();

        const planned = await mockMedia({ descriptor: () => ({ contracts: { version: '0.30.0' }, services: [{ id: 'media', status: 'planned', origin: null, planned_origin: 'https://openvibe.media' }] }) });
        const p = createObjectsClient({ app: 'demo', tokenClient: tokenClient(), network: planned.srv.url });
        await assert.rejects(p.get('med_x'), (e) => e.code === 'sdk.service_unavailable' && /planned at https:\/\/openvibe.media/.test(e.message));
        await planned.srv.close();
        const none = await mockMedia({ descriptor: () => ({ contracts: { version: '0.30.0' }, services: [{ id: 'network', status: 'stable', origin: 'https://openvibe.network' }] }) });
        await assert.rejects(createObjectsClient({ app: 'demo', tokenClient: tokenClient(), network: none.srv.url }).list(), (e) => e.code === 'sdk.service_unavailable');
        await none.srv.close();
        assert.throws(() => createObjectsClient({ tokenClient: tokenClient() }), TypeError);
        assert.throws(() => createObjectsClient({ app: 'demo' }), TypeError);
    }],

    ['single upload: init with size, type and sha256; the bytes go to the presigned URL without a credential; complete', async () => {
        const m = await mockMedia();
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, tokenClient: tokenClient(), subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
        const bytes = crypto.randomBytes(5000);
        const progress = [];
        const obj = await objects.upload(bytes, { kind: 'screenshot', visibility: 'public', mimeType: 'image/png', filename: 'a.png', metadata: { a: 1 }, onProgress: (p) => progress.push(p) });
        assert.deepEqual([obj.lifecycle_status, obj.size_bytes, obj.content_hash], ['ready', 5000, sha(bytes)]);
        const init = m.srv.requests.find((r) => r.method === 'POST' && r.url === '/api/v2/demo/objects');
        assert.deepEqual(JSON.parse(init.body), { kind: 'screenshot', visibility: 'public', size_bytes: 5000, mime_type: 'image/png', filename: 'a.png', metadata: { a: 1 }, content_hash: sha(bytes) });
        assert.equal(init.headers.authorization, 'Bearer svc-token');
        assert.equal(init.headers['x-ov-subject'], 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        const put = m.srv.requests.find((r) => r.method === 'PUT');
        assert.equal(put.headers.authorization, undefined, 'the presigned URL carries the credential');
        assert.equal(put.headers['content-type'], 'image/png');
        assert.deepEqual(put.body, bytes);
        assert.equal(progress.at(-1).uploadedBytes, 5000);
        await assert.rejects(objects.upload(new Uint8Array(0)), TypeError);
        await assert.rejects(objects.upload({ nope: true }), TypeError);
        await m.srv.close();
    }],

    ['multipart by size: parts with sha256, in parallel; complete names every part; the object is the original', async () => {
        const m = await mockMedia();
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, tokenClient: tokenClient(), multipartThreshold: 10000, partSize: 4096, concurrency: 3 });
        const bytes = crypto.randomBytes(4096 * 4 + 100);
        const obj = await objects.upload(new Blob([bytes], { type: 'video/webm' }), { kind: 'vod' });
        const init = JSON.parse(m.srv.requests.find((r) => r.url === '/api/v2/demo/objects').body);
        assert.deepEqual([init.multipart, init.part_size, init.mime_type, init.content_hash], [true, 4096, 'video/webm', sha(bytes)]);
        const s = [...m.state.sessions.values()][0];
        assert.equal(s.parts_expected, 5);
        const puts = m.srv.requests.filter((r) => r.method === 'PUT');
        assert.equal(puts.length, 5);
        assert.ok(puts.every((r) => !r.headers.authorization && r.headers['x-content-sha256'] === sha(r.body)), 'no credential, each part with its sha256');
        assert.deepEqual(s.completeBody.parts.map((p) => p.part_number), [1, 2, 3, 4, 5]);
        assert.equal(s.completeBody.content_hash, sha(bytes));
        assert.deepEqual(m.state.objects.get(obj.id).bytes, bytes);
        assert.equal(obj.lifecycle_status, 'ready');
        await m.srv.close();
    }],

    ['Media refusing a single part (413) sends it as multipart instead', async () => {
        const m = await mockMedia({ singleMax: 1000 });
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, tokenClient: tokenClient(), partSize: 1024 });
        const bytes = crypto.randomBytes(3000);
        const obj = await objects.upload(bytes);
        assert.equal(obj.lifecycle_status, 'ready');
        const inits = m.srv.requests.filter((r) => r.url === '/api/v2/demo/objects').map((r) => JSON.parse(r.body).multipart);
        assert.deepEqual(inits, [undefined, true]);
        assert.deepEqual(m.state.objects.get(obj.id).bytes, bytes);
        await m.srv.close();
    }],

    ['dropped connections: a part that keeps failing is sent again in the next round after reading the session back', async () => {
        let drops = 0;
        const m = await mockMedia({ failPart: (k) => k === 2 && drops++ < 4 });
        const client = createClient({ retryDelayMs: 1, retries: 2 });
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, client, apiKey: 'app-key', multipartThreshold: 100, partSize: 1000 });
        const bytes = crypto.randomBytes(2500);
        const obj = await objects.upload(bytes);
        assert.equal(obj.lifecycle_status, 'ready');
        assert.equal(m.state.failures, 4, 'three attempts in round 1 (the client retries), one more in round 2');
        const s = [...m.state.sessions.values()][0];
        assert.ok(s.calls.filter((c) => c.what === 'status').length >= 2, 'the session was read back');
        assert.deepEqual(m.state.objects.get(obj.id).bytes, bytes);
        assert.equal(m.srv.requests[0].headers.authorization, 'Bearer app-key', 'the app key when given');
        await m.srv.close();
    }],

    ['a part that never goes up: sdk.upload_incomplete with err.resume; resume() finishes it with the credential', async () => {
        let broken = true;
        const m = await mockMedia({ failPart: (k) => k === 3 && broken });
        const client = createClient({ retryDelayMs: 1, retries: 0, token: 'svc-token' });
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, client, multipartThreshold: 100, partSize: 1000, resumeRounds: 1 });
        const bytes = crypto.randomBytes(2500);
        const err = await objects.upload(bytes).then(() => null, (e) => e);
        assert.equal(err && err.code, 'sdk.upload_incomplete');
        assert.deepEqual(err.resume.missing, [3]);
        broken = false;
        const s = m.state.sessions.get(err.resume.uploadId);
        s.parts.set(2, Buffer.alloc(1000));                 // a part that differs from our bytes: sent again
        s.calls.length = 0;
        const done = await objects.resume(err.resume, bytes);
        assert.equal(done.lifecycle_status, 'ready');
        assert.deepEqual(s.calls.filter((c) => c.what === 'parts').map((c) => [c.n, c.authed]).sort(), [[2, true], [3, true]], 'only the stale and the missing part, with the credential');
        assert.deepEqual(m.state.objects.get(err.resume.objectId).bytes, bytes);
        await assert.rejects(objects.resume(err.resume, bytes), (e) => e.code === 'sdk.upload_incomplete', 'a completed session cannot be resumed');
        await m.srv.close();
    }],

    ['get, signedUrl, delete, list and iterate', async () => {
        const m = await mockMedia();
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, apiKey: 'k', actingUserId: 7 });
        const a = await objects.upload('one');
        await objects.upload('two');
        await objects.upload('three');
        assert.equal((await objects.get(a.id)).id, a.id);
        assert.equal(await objects.get('med_missing'), null);
        const link = await objects.signedUrl(a.id, { ttl: 120 });
        assert.deepEqual([link.public, link.format, new URL(link.url).searchParams.get('ttl')], [false, 'json', '120']);
        const page = await objects.list({ limit: 2 });
        assert.equal(page.objects.length, 2);
        assert.ok(page.next_cursor);
        const all = [];
        for await (const o of objects.iterate({ limit: 2 })) all.push(o.id);
        assert.equal(all.length, 3);
        assert.equal(await objects.delete(a.id), true);
        assert.equal(await objects.delete('med_missing'), false);
        assert.ok(m.srv.requests.filter((r) => r.headers.authorization).every((r) => r.headers['x-ov-user-id'] === '7'), 'X-OV-User-Id on every credentialed call');
        await m.srv.close();
    }],

    ['jobs: create with an Idempotency-Key, get, approve, cancel, wait', async () => {
        const m = await mockMedia();
        const objects = createObjectsClient({ app: 'demo', baseUrl: m.srv.url, tokenClient: tokenClient() });
        const job = await objects.jobs.create({ type: 'object.remux', objectId: 'med_1', idempotencyKey: 'remux-1' });
        assert.deepEqual([job.type, job.object_id, job.status], ['object.remux', 'med_1', 'queued']);
        assert.equal(m.srv.requests.at(-1).headers['idempotency-key'], 'remux-1');
        assert.equal((await objects.jobs.create({ type: 'object.remux', objectId: 'med_1', idempotencyKey: 'remux-1' })).id, job.id, 'a repeat answers the same job');
        const done = await objects.jobs.wait(job.id, { intervalMs: 5 });
        assert.equal(done.status, 'succeeded');
        assert.equal(await objects.jobs.get('mjob_nope'), null);
        const other = await objects.jobs.create({ type: 'invariant.scan' });
        assert.equal((await objects.jobs.approve(other.id)).status, 'queued');
        assert.equal((await objects.jobs.cancel(other.id)).status, 'cancelled');
        assert.equal((await objects.jobs.list({ status: 'cancelled' })).jobs.length, 1);
        await assert.rejects(objects.jobs.create({}), TypeError);
        await m.srv.close();
    }],
]);
