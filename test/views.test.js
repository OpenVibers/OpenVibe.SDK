'use strict';
const assert = require('assert');
const { createViewsClient, eventOf, refOf } = require('../src/views');

(async () => {
    const calls = [];
    const client = { json: async (input) => { calls.push(input); return { results: [{ accepted: true, counted: true, engaged: false }] }; } };
    const views = createViewsClient(client, { baseUrl: 'https://media.test/' });

    await views.record({ ref: { service: 'media', kind: 'vod', id: 42 }, how: 'preview', seconds: 2, session: 'anon_9f2c1e7a4b' });
    assert.deepStrictEqual(calls[0], {
        baseUrl: 'https://media.test', path: '/api/v1/views', method: 'POST', service: 'media', signal: undefined,
        json: { events: [{ ref: { service: 'media', kind: 'vod', id: '42' }, how: 'preview', seconds: 2, session: 'anon_9f2c1e7a4b' }] },
    });

    await views.record([
        { ref: { service: 'live', kind: 'stream', id: '7', site: 'network', creator: 'maticus' }, how: 'live', seconds: 61 },
        { ref: { service: 'media', kind: 'clip', id: '3' }, how: 'watch', seconds: 30, of_seconds: 90 },
    ]);
    assert.strictEqual(calls[1].json.events.length, 2);
    assert.strictEqual(calls[1].json.events[0].ref.site, 'network');

    await views.counts({ service: 'media', kind: 'vod', id: 42 });
    assert.deepStrictEqual(calls[2].query, { service: 'media', kind: 'vod', id: '42' });

    assert.throws(() => views.record(Array.from({ length: 21 }, () => ({ ref: { service: 'media', kind: 'clip', id: '1' }, how: 'preview', seconds: 2 }))), /at most 20/);
    assert.throws(() => eventOf({ ref: { service: 'media', kind: 'clip', id: '1' }, how: 'scroll', seconds: 2 }), /how is/);
    assert.throws(() => refOf({ service: 'Media', kind: 'clip', id: '1' }), /service is a service id/);
    assert.throws(() => eventOf({ ref: { service: 'media', kind: 'clip', id: '1' }, how: 'watch', seconds: 1, session: 'short' }), /session is/);
    console.log('views: record batches and counts a ref with the documented shapes');
})().catch((error) => { console.error(error); process.exitCode = 1; });
