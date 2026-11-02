'use strict';
/** Meme client: routes, query/body shapes, envelopes, validation and problem errors. */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient, OpenVibeError } = require('../src/core');
const { createMemeClient } = require('../src/meme');

async function memeServer() {
    return stubServer((req, res, body) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/entries') return send(res, 200, { count: 1, entries: [{ id: 'mem_1', slug: 'doge', scope: 'internet' }], next_cursor: null });
        if (u.pathname === '/api/v1/entries/doge') return send(res, 200, { id: 'mem_1', slug: 'doge', origin: { url: 'https://example.com/doge' }, revisions: [] });
        if (u.pathname === '/api/v1/entries/doge/revisions') return send(res, 200, { slug: 'doge', count: 0, revisions: [] });
        if (u.pathname === '/api/v1/entries/missing') return problem(res, 404, 'meme.not_found', 'No such meme.');
        if (u.pathname === '/api/v1/trends') return send(res, 200, { window: 'week', rising: [], templates: [], entries: [], subreddits: [] });
        if (u.pathname === '/api/v1/analyze') return send(res, 200, { id: 'anl_1', template: { name: 'Doge' }, labels: ['language'] });
        if (u.pathname === '/api/v1/research' && req.method === 'POST') return send(res, 202, { id: 'rsc_1', topic: 'Doge', status: 'queued' });
        if (u.pathname === '/api/v1/research/rsc_1' && req.method === 'GET') return send(res, 200, { id: 'rsc_1', status: 'succeeded', sources: [] });
        if (u.pathname === '/api/v1/research/rsc_1/entry' && req.method === 'POST') return send(res, 201, { entry: { id: 'mem_2', slug: 'doge-deep-dive' }, already: false });
        if (u.pathname === '/api/v1/generate' && req.method === 'POST') return send(res, 201, { media_id: 'med_1', captions: ['one'], template: { id: 'tpl_classic' }, labels: [] });
        return problem(res, 404, 'meme.not_found', 'Missing');
    });
}

run([
    ['all Meme routes preserve paths, query, bodies and envelopes', async () => {
        const srv = await memeServer();
        try {
            const meme = createMemeClient(createClient({ baseUrls: { meme: srv.url }, retries: 0 }));
            const search = await meme.search({ scope: 'internet', q: 'doge', label: '18+', sort: 'top', window: 'week', channel: 7001, limit: 5 });
            assert.equal(search.count, 1);
            assert.equal(search.entries[0].slug, 'doge');
            const searchReq = new URL(srv.requests[0].url, 'http://x');
            assert.equal(searchReq.pathname, '/api/v1/entries');
            assert.equal(searchReq.searchParams.get('scope'), 'internet');
            assert.equal(searchReq.searchParams.get('q'), 'doge');
            assert.equal(searchReq.searchParams.get('label'), '18+');
            assert.equal(searchReq.searchParams.get('sort'), 'top');
            assert.equal(searchReq.searchParams.get('window'), 'week');
            assert.equal(searchReq.searchParams.get('channel'), '7001');
            assert.equal(searchReq.searchParams.get('limit'), '5');

            assert.equal((await meme.entry('doge')).origin.url, 'https://example.com/doge');
            assert.equal((await meme.revisions('doge')).count, 0);
            assert.equal((await meme.trends({ window: 'week' })).window, 'week');
            assert.equal((await meme.analyze({ url: 'https://example.com/doge.png' })).id, 'anl_1');
            assert.equal((await meme.analyze({ mediaId: 'med_1' })).id, 'anl_1');
            const analyzeBody = JSON.parse(srv.requests.at(-1).body.toString('utf8'));
            assert.deepEqual(analyzeBody, { media_id: 'med_1' });

            assert.equal((await meme.research('Doge')).status, 'queued');
            assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString('utf8')), { topic: 'Doge' });
            assert.equal((await meme.researchGet('rsc_1')).status, 'succeeded');
            assert.equal((await meme.saveResearch('rsc_1')).entry.slug, 'doge-deep-dive');

            assert.equal((await meme.generate({ template: 'tpl_classic', lines: ['one'] })).media_id, 'med_1');
            assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString('utf8')), { template_slug: 'tpl_classic', lines: ['one'] });
            assert.equal((await meme.generate({ topic: 'Doge' })).media_id, 'med_1');
            assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString('utf8')), { topic: 'Doge' });
        } finally { await srv.close(); }
    }],
    ['Meme validation is local and errors keep the problem code', async () => {
        const srv = await memeServer();
        try {
            const meme = createMemeClient(createClient({ baseUrls: { meme: srv.url }, retries: 0 }));
            assert.throws(() => meme.analyze({}), TypeError);
            assert.throws(() => meme.analyze({ url: 'https://x.test/a.png', media_id: 'med_1' }), TypeError);
            assert.throws(() => meme.generate({}), TypeError);
            assert.equal(srv.requests.length, 0, 'no request left the client for a bad input');
            await assert.rejects(() => meme.entry('missing'), (err) => err instanceof OpenVibeError && err.status === 404 && err.code === 'meme.not_found');
        } finally { await srv.close(); }
    }],
    ['the browser bundle and ESM entry expose the client', async () => {
        const esm = await import('../esm/meme.mjs');
        assert.equal(typeof esm.createMemeClient, 'function');
        const top = await import('../esm/index.mjs');
        assert.equal(typeof top.meme.createMemeClient, 'function');
    }],
]);
