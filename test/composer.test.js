'use strict';
/** The shared composer client: XHR upload with real progress, abort, remove, prefs with the revision, mentions. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createComposerClient } = require('../src/composer');

function fakeXHR({ never = false } = {}) {
    return class FakeXHR {
        constructor() { this.upload = {}; this.headers = {}; this.sent = false; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
        send(body) {
            this.sent = true;
            this.body = body;
            if (never) return;
            fetch(this.url, { method: this.method, headers: this.headers, body }).then(async (r) => {
                this.status = r.status;
                this.responseText = await r.text();
                this.upload.onprogress?.({ loaded: 1, total: 1, lengthComputable: true });
                this.onload?.();
            }).catch((err) => this.onerror?.(err));
        }
        abort() { this.aborted = true; }
    };
}

run([
    ['the ESM entry exports the same client', async () => {
        const esm = await import('../esm/composer.mjs');
        assert.equal(typeof esm.createComposerClient, 'function');
        assert.equal(esm.MEDIA_ORIGIN, 'https://openvibe.media');
    }],

    ['upload posts one multipart file through XHR, with the token and progress', async () => {
        const srv = await stubServer((req, res) => send(res, 201, {
            id: 'att_01JAB2C3D4E5F6G7H8J9K0MNPQ', kind: 'image', name: 'shot.png', size: 3, mime: 'image/png',
            url: 'https://openvibe.media/a/att_01JAB2C3D4E5F6G7H8J9K0MNPQ/shot.png', thumb: null, w: 1, h: 1,
            expires_at: '2026-11-11T12:00:00.000Z',
        }));
        const composer = createComposerClient(createClient({ baseUrls: { media: srv.url }, token: 'person-token' }));
        const progress = [];
        const out = await composer.attachments.upload(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
            filename: 'shot.png', onProgress: (p) => progress.push(p), xhr: fakeXHR(),
        });
        assert.equal(out.id, 'att_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.equal(out.kind, 'image');
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/api/v1/attachments');
        assert.equal(r.headers.authorization, 'Bearer person-token');
        assert.match(r.headers['content-type'], /^multipart\/form-data; boundary=/);
        const text = r.body.toString('latin1');
        assert.match(text, /name="file"; filename="shot.png"/);
        assert.match(text, /content-type: image\/png/i);
        assert.ok(progress.length >= 1 && progress.every((p) => p.loaded <= p.total && p.total === 1), 'real XHR progress');
        await srv.close();
    }],

    ['a getToken client supplies the upload token; a signal aborts', async () => {
        const composer = createComposerClient(createClient({ baseUrls: { media: 'http://127.0.0.1:9' }, getToken: async ({ service, audience }) => `${service}:${audience}` }));
        assert.equal(composer.MEDIA_ORIGIN, 'https://openvibe.media');
        const ctrl = new AbortController();
        const p = composer.attachments.upload(new Blob(['x']), { signal: ctrl.signal, xhr: fakeXHR({ never: true }) });
        ctrl.abort();
        await assert.rejects(p, (err) => err.code === 'sdk.aborted');
    }],

    ['remove deletes and answers true, false when already gone', async () => {
        const srv = await stubServer((req, res) => (req.url.endsWith('/missing') ? send(res, 404, { code: 'media.attachment.not_found' }) : res.writeHead(204).end()));
        const composer = createComposerClient(createClient({ baseUrls: { media: srv.url } }), { mediaBaseUrl: srv.url });
        assert.equal(await composer.attachments.remove('att_01JAB2C3D4E5F6G7H8J9K0MNPQ'), true);
        assert.equal(await composer.attachments.remove('missing'), false);
        assert.deepEqual(srv.requests.map((r) => `${r.method} ${r.url}`), ['DELETE /api/v1/attachments/att_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'DELETE /api/v1/attachments/missing']);
        await srv.close();
    }],

    ['prefs get/put name the revision; a stale rev carries the current copy', async () => {
        const prefs = { rev: 2, send_key: 'enter', tools: [{ id: 'attach', hidden: false }], density: 'comfy', voice: true, snippets: [] };
        const srv = await stubServer((req, res, raw) => {
            if (req.method === 'GET') return send(res, 200, prefs);
            const body = JSON.parse(raw.toString());
            if (body.rev !== 2) return send(res, 409, { status: 409, code: 'composer.rev_conflict', error: 'moved', current: prefs });
            return send(res, 200, { ...body, rev: 3 });
        });
        const composer = createComposerClient(createClient({ baseUrls: { network: srv.url } }), { networkBaseUrl: srv.url });
        assert.deepEqual(await composer.composer.prefs.get(), prefs);
        const saved = await composer.composer.prefs.put({ send_key: 'mod-enter', tools: [], density: 'compact', voice: false, snippets: [] }, 2);
        assert.equal(saved.rev, 3);
        assert.equal(saved.send_key, 'mod-enter');
        const sent = JSON.parse(srv.requests[1].body.toString());
        assert.equal(srv.requests[1].method, 'PUT');
        assert.equal(sent.rev, 2);
        await assert.rejects(composer.composer.prefs.put({ send_key: 'enter', tools: [], density: 'comfy', voice: true, snippets: [] }, 1), (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, 'composer.rev_conflict');
            assert.equal(err.problem.current.rev, 2);
            return true;
        });
        assert.throws(() => composer.composer.prefs.put({}, '2'), TypeError);
        await srv.close();
    }],

    ['mentions searches with q and kinds and returns the list', async () => {
        const srv = await stubServer((req, res) => send(res, 200, { mentions: [
            { kind: 'person', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', label: 'Ana', handle: 'ana', avatar: null, url: 'https://openvibe.network/@ana' },
        ] }));
        const composer = createComposerClient(createClient({ baseUrls: { network: srv.url } }));
        const out = await composer.mentions.search('an a', ['person', 'repo']);
        assert.equal(out.length, 1);
        assert.equal(out[0].handle, 'ana');
        const u = new URL(`http://x${srv.requests[0].url}`);
        assert.equal(u.pathname, '/api/v1/mentions');
        assert.equal(u.searchParams.get('q'), 'an a');
        assert.equal(u.searchParams.get('kinds'), 'person,repo');
        await srv.close();
    }],
]);
