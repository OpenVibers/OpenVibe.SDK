'use strict';
/** Search: query filters and facets, cursor iteration, suggest, a missing document is null, acting subject. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createSearchClient, queryOf } = require('../src/search');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

async function search() {
    return stubServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/search') {
            const cursor = u.searchParams.get('cursor');
            if (!cursor) return send(res, 200, { results: [{ owner: 'live', type: 'vod', id: '1' }, { owner: 'live', type: 'vod', id: '2' }], next_cursor: 'c2' });
            return send(res, 200, { results: [{ owner: 'live', type: 'vod', id: '3' }], next_cursor: null });
        }
        if (u.pathname === '/api/v1/suggest') return send(res, 200, { suggestions: [{ owner: 'live', type: 'channel', id: '327', title: 'JapaneseOldGuy' }] });
        if (u.pathname.startsWith('/api/v1/documents/live/channel/404')) return send(res, 404, { type: 'about:blank', code: 'search.not_found', status: 404 });
        if (u.pathname.startsWith('/api/v1/documents/')) return send(res, 200, { owner: 'live', type: 'channel', id: '327' });
        return send(res, 404, {});
    });
}

run([
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
