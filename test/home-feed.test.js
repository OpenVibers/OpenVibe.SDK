'use strict';
const assert = require('node:assert/strict');
const { createHomeFeedClient } = require('../src/home-feed');

(async () => {
    const calls = [];
    const client = { json: async (opts) => { calls.push(opts); return opts; } };
    const ov = createHomeFeedClient(client);
    const layout = { home: ['live'], folders: [] };
    await ov.home.get();
    await ov.home.set(layout);
    await ov.network.today();
    await ov.network.popular({ limit: 5 });
    await ov.network.tryNext({ limit: 3 });
    await ov.feed.list({ for: 'me', cursor: 'next' });
    await ov.feed.post('Hello', { link: 'https://openvibe.live/' });
    await ov.feed.contribute({ id: 'update-1', text: 'New thing', url: 'https://example.test/' });
    assert.deepEqual(calls.map((c) => [c.service, c.method || 'GET', c.path]), [
        ['network', 'GET', '/api/v1/me/home-screen'], ['network', 'PUT', '/api/v1/me/home-screen'],
        ['network', 'GET', '/api/v1/frame/today'], ['network', 'GET', '/api/v1/home/popular'],
        ['network', 'GET', '/api/v1/me/try-next'], ['community', 'GET', '/api/v1/pulse'],
        ['community', 'POST', '/api/v1/me/status'], ['community', 'POST', '/api/v1/pulse/items'],
    ]);
    assert.deepEqual(calls[1].json, layout);
    assert.equal(calls[2].auth, false);
    assert.equal(calls[3].auth, false);
    assert.deepEqual(calls[3].query, { limit: 5 });
    assert.equal(calls[4].auth, undefined);
    assert.deepEqual(calls[4].query, { limit: 3 });
    assert.deepEqual(calls[5].query, { for: 'me', cursor: 'next' });
    assert.equal(calls[6].idempotencyKey, false);
    assert.equal(calls[7].idempotencyKey, false);
    const esm = await import('../esm/home-feed.mjs');
    assert.equal(typeof esm.createHomeFeedClient, 'function');
    const packageEntry = await import('openvibe-sdk/home-feed');
    assert.equal(typeof packageEntry.createHomeFeedClient, 'function');
    console.log('home-feed: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
