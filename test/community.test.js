'use strict';
/** Community pastes: acting-subject / origin / source-ref / staff headers, no retried writes. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createCommunityClient, actingHeaders } = require('../src/community');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const GST = 'gst_01JAB2C3D4E5F6G7H8J9K0MNPQ';

async function echo() {
    return stubServer((req, res) => {
        if (req.url.includes('/missing')) return send(res, 404, { error: 'Paste not found' });
        if (req.url.includes('/busy')) return send(res, 503, { error: 'busy' });
        if (req.method === 'GET' && req.url.startsWith('/api/pastes?')) {
            const q = new URL(req.url, 'http://x').searchParams;
            const offset = Number(q.get('offset'));
            const limit = Number(q.get('limit'));
            const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, slug: `s${i + 1}` }));
            return send(res, 200, { pastes: all.slice(offset, offset + limit), total: all.length, limit, offset });
        }
        return send(res, 200, { ok: true });
    });
}
const hdr = (r, k) => r.headers[k.toLowerCase()];

run([
    ['service acting for a person sends X-OV-Subject (and the service token)', async () => {
        const srv = await echo();
        const community = createCommunityClient(createClient({ baseUrls: { community: srv.url }, getToken: ({ audience }) => `svc-for-${audience}` }), { actingSubject: USR });
        await community.pastes.create({ title: 't', content: 'hello', language: 'js' });
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/api/pastes');
        assert.equal(hdr(r, 'Authorization'), 'Bearer svc-for-openvibe.community');
        assert.equal(hdr(r, 'X-OV-Subject'), USR);
        assert.equal(hdr(r, 'X-OV-Origin'), undefined);
        assert.deepEqual(JSON.parse(r.body), { title: 't', content: 'hello', language: 'js' });
        await srv.close();
    }],

    ['origin ai sends X-OV-Origin: ai and never a subject; sourceRef and staff', async () => {
        const srv = await echo();
        const base = createCommunityClient(createClient({ baseUrls: { community: srv.url }, token: 'svc' }));
        const ai = base.as({ origin: 'ai', actingSubject: USR, sourceRef: { service: 'live', type: 'stream', id: '12' } });
        await ai.pastes.create({ content: 'summary' });
        let r = srv.requests[0];
        assert.equal(hdr(r, 'X-OV-Origin'), 'ai');
        assert.equal(hdr(r, 'X-OV-Subject'), undefined, 'AI output is not attributed to a person');
        assert.deepEqual(JSON.parse(hdr(r, 'X-OV-Source-Ref')), { service: 'live', type: 'stream', id: '12' });
        await base.pastes.delete('abc', { actingSubject: GST, staff: true });
        r = srv.requests[1];
        assert.equal(r.method, 'DELETE');
        assert.equal(hdr(r, 'X-OV-Subject'), GST);
        assert.equal(hdr(r, 'X-OV-Staff'), '1');
        await base.as(USR).pastes.like('abc');
        assert.equal(hdr(srv.requests[2], 'X-OV-Subject'), USR);
        await base.pastes.like('abc');
        assert.equal(hdr(srv.requests[3], 'X-OV-Subject'), undefined, 'as() did not leak into the base client');
        assert.throws(() => actingHeaders({ actingSubject: '42' }), TypeError);
        assert.throws(() => actingHeaders({ origin: 'bot' }), TypeError);
        assert.deepEqual(actingHeaders({ actingSubject: USR, origin: 'user' }), { 'X-OV-Origin': 'user', 'X-OV-Subject': USR });
        await srv.close();
    }],

    ['browser mode: cookie credentials, no X-OV headers, no Authorization', async () => {
        const srv = await echo();
        const seen = [];
        const fetchSpy = (url, init) => { seen.push(init); return fetch(url, init); };
        const community = createCommunityClient(createClient({ baseUrls: { community: srv.url }, credentials: 'include', fetch: fetchSpy }));
        await community.pastes.get('abc', { noView: true });
        const r = srv.requests[0];
        assert.equal(r.url, '/api/pastes/abc?no_view=1');
        assert.equal(hdr(r, 'Authorization'), undefined);
        assert.ok(!Object.keys(r.headers).some((k) => k.startsWith('x-ov-')));
        assert.equal(seen[0].credentials, 'include');
        assert.equal(await community.pastes.get('missing'), null);
        await srv.close();
    }],

    ['writes Community does not dedupe are never retried', async () => {
        const srv = await echo();
        const community = createCommunityClient(createClient({ baseUrls: { community: srv.url }, retryDelayMs: 5 }));
        await assert.rejects(community.pastes.like('busy'), { status: 503 });
        await assert.rejects(community.pastes.comments.create('busy', { content: 'hi' }), { status: 503 });
        const busy = srv.requests.filter((r) => r.url.includes('/busy'));
        assert.equal(busy.length, 2, 'one request each');
        assert.ok(busy.every((r) => !r.headers['idempotency-key']));
        await assert.rejects(community.pastes.update('busy', { title: 'y' }), { status: 503 });
        assert.equal(srv.requests.filter((r) => r.method === 'PUT').length, 3, 'PUT is idempotent: retried');
        await srv.close();
    }],

    ['routes: fork, copy, versions, by-user, config, comments, screenshot multipart, iterate', async () => {
        const srv = await echo();
        const p = createCommunityClient(createClient({ baseUrls: { community: srv.url } })).pastes;
        await p.fork('a1');
        await p.copy('a1');
        await p.versions('a1');
        await p.byUser('ana', { limit: 5 });
        await p.config();
        await p.comments.list('a1', { limit: 10 });
        await p.comments.create('a1', { content: 'nice', parent_id: 3 });
        await p.comments.delete('a1', 9);
        await p.create({ screenshot: new Uint8Array([137, 80, 78, 71]), filename: 'shot.png', title: 'look' });
        const lines = srv.requests.map((r) => `${r.method} ${r.url}`);
        assert.deepEqual(lines, [
            'POST /api/pastes/a1/fork', 'POST /api/pastes/a1/copy', 'GET /api/pastes/a1/versions', 'GET /api/pastes/by-user/ana?limit=5',
            'GET /api/pastes/config', 'GET /api/pastes/a1/comments?limit=10', 'POST /api/pastes/a1/comments', 'DELETE /api/pastes/a1/comments/9', 'POST /api/pastes',
        ]);
        const shot = srv.requests.at(-1);
        assert.match(shot.headers['content-type'], /^multipart\/form-data/);
        assert.match(shot.body.toString('latin1'), /name="title"\r\n\r\nlook/);
        assert.match(shot.body.toString('latin1'), /name="screenshot"; filename="shot.png"\r\nContent-Type: image\/png/);
        const slugs = [];
        for await (const x of p.iterate({ limit: 2 })) slugs.push(x.slug);
        assert.deepEqual(slugs, ['s1', 's2', 's3', 's4', 's5']);
        await srv.close();
    }],
]);
