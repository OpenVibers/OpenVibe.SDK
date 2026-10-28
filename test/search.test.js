'use strict';
/** Search: query filters and facets, cursor iteration, suggest, a missing document is null, acting subject. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createSearchClient, queryOf, fabricOf } = require('../src/search');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

async function search() {
    return stubServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/search') {
            const cursor = u.searchParams.get('cursor');
            if (!cursor) return send(res, 200, { results: [{ owner: 'live', type: 'vod', id: '1' }, { owner: 'live', type: 'vod', id: '2' }], next_cursor: 'c2' });
            return send(res, 200, { results: [{ owner: 'live', type: 'vod', id: '3' }], next_cursor: null });
        }
        if (u.pathname === '/api/v1/query') return send(res, 200, { results: [{ scope: 'web', kind: 'page', title: 'A', url: 'https://example.org/a', provider: 'wikipedia' }], groups: { web: 1 }, answer: null, citations: [], route: { explain: [{ scope: 'web', step: 'wikipedia', ok: true, count: 1 }], cost_usd: 0 }, next_cursor: null });
        if (u.pathname === '/api/v1/query/providers') return send(res, 200, { providers: [{ provider: 'deepseek', scopes: ['web'], price_usd_per_call: 0.00075, available: true, checked_at: '2026-10-28T12:00:00Z' }] });
        if (u.pathname === '/api/v1/suggest') return send(res, 200, { suggestions: [{ owner: 'live', type: 'channel', id: '327', title: 'JapaneseOldGuy' }] });
        if (u.pathname.startsWith('/api/v1/documents/live/channel/404')) return send(res, 404, { type: 'about:blank', code: 'search.not_found', status: 404 });
        if (u.pathname.startsWith('/api/v1/documents/')) return send(res, 200, { owner: 'live', type: 'channel', id: '327' });
        return send(res, 404, {});
    });
}

run([
    ['fabric: scopes go to GET /api/v1/query; query() with scopes is the same call; providers', async () => {
        const srv = await search();
        const s = createSearchClient(createClient({ baseUrls: { search: srv.url } }));
        const r = await s.fabric('surf maps', { scopes: ['network', 'web'], freshness: 'month', depth: 'deep', site: 'example.org', limit: 5, answer: true });
        assert.equal(r.results[0].provider, 'wikipedia');
        assert.equal(r.route.cost_usd, 0);
        const u = new URL(srv.requests[0].url, 'http://x');
        assert.equal(srv.requests[0].method, 'GET', 'a read: the client may retry it');
        assert.deepEqual([u.pathname, u.searchParams.get('q'), u.searchParams.get('scopes'), u.searchParams.get('freshness'), u.searchParams.get('depth'), u.searchParams.get('site'), u.searchParams.get('limit'), u.searchParams.get('answer')],
            ['/api/v1/query', 'surf maps', 'network,web', 'month', 'deep', 'example.org', '5', 'true']);
        await s.query('x', { scopes: 'web' });
        assert.equal(new URL(srv.requests[1].url, 'http://x').pathname, '/api/v1/query', 'query() with scopes is the fabric');
        await s.query('x', { owner: 'live' });
        assert.equal(new URL(srv.requests[2].url, 'http://x').pathname, '/api/v1/search', 'without scopes, the index search as before');
        assert.equal(new URL(srv.requests[3] ? srv.requests[3].url : 'http://x/none', 'http://x').pathname, '/none');
        const p = await s.providers();
        assert.equal(p.providers[0].provider, 'deepseek');
        assert.deepEqual(fabricOf('q'), { q: 'q', scopes: 'network' }, 'network by default');
        await srv.close();
    }],
    ['query sends owner, type, facet filters and facet keys', async () => {
        const srv = await search();
        const s = createSearchClient(createClient({ baseUrls: { search: srv.url } }));
        const page = await s.query('forum', { owner: 'community', type: 'thread', filter: { space: 'roadmap', tags: ['a', 'b'] }, facets: ['space', 'kind'], limit: 5 });
        assert.equal(page.next_cursor, 'c2');
        const u = new URL(srv.requests[0].url, 'http://x');
        assert.equal(u.searchParams.get('q'), 'forum');
        assert.equal(u.searchParams.get('owner'), 'community');
        assert.equal(u.searchParams.get('type'), 'thread');
        assert.equal(u.searchParams.get('facet.space'), 'roadmap');
        assert.deepEqual(u.searchParams.getAll('facet.tags'), ['a', 'b']);
        assert.equal(u.searchParams.get('facets'), 'space,kind');
        assert.equal(srv.requests[0].headers.authorization, undefined, 'anonymous unless a token is configured');
        assert.throws(() => queryOf('x', { filter: { 'Bad Key': 1 } }), /malformed/);
        await srv.close();
    }],
    ['iterate follows the cursor until Search has no more; max stops early', async () => {
        const srv = await search();
        const s = createSearchClient(createClient({ baseUrls: { search: srv.url } }));
        const ids = [];
        for await (const d of s.iterate('vod', { owner: 'live' })) ids.push(d.id);
        assert.deepEqual(ids, ['1', '2', '3']);
        assert.equal(new URL(srv.requests[1].url, 'http://x').searchParams.get('cursor'), 'c2');
        const two = [];
        for await (const d of s.iterate('vod', { max: 2 })) two.push(d.id);
        assert.deepEqual(two, ['1', '2']);
        await srv.close();
    }],
    ['suggest, document, a missing document is null, a service acts for a person', async () => {
        const srv = await search();
        const s = createSearchClient(createClient({ baseUrls: { search: srv.url }, getToken: ({ audience }) => `svc-${audience}` }), { actingSubject: USR });
        assert.equal((await s.suggest('japan', { owner: 'live' })).suggestions[0].title, 'JapaneseOldGuy');
        assert.equal((await s.document('live', 'channel', '327')).id, '327');
        assert.equal(await s.document('live', 'channel', '404'), null);
        const r = srv.requests[0];
        assert.equal(r.headers.authorization, 'Bearer svc-openvibe.search');
        assert.equal(r.headers['x-ov-subject'], USR);
        assert.throws(() => createSearchClient(createClient({ baseUrls: { search: srv.url } })).query('x', { actingSubject: 'nope' }), /actingSubject/);
        await srv.close();
    }],
]);
