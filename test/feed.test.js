'use strict';
const assert = require('assert');
const { createFeedClient } = require('../src/feed');

(async () => {
    const calls = [];
    const client = createFeedClient({ json: async (input) => { calls.push(input); return { items: [], next_cursor: null }; } }, { communityBaseUrl: 'https://community.test' });
    const result = await client.list({ kind: 'clip', cursor: 'opaque' });
    assert.deepStrictEqual(result, { items: [], next_cursor: null });
    assert.deepStrictEqual(calls[0], { service: 'community', baseUrl: 'https://community.test', audience: 'openvibe.community', path: '/api/v1/feed', query: { kind: 'clip', cursor: 'opaque' }, signal: undefined });
    console.log('feed.list sends kind and cursor to Community');
})().catch((error) => { console.error(error); process.exitCode = 1; });
