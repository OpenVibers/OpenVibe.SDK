'use strict';
const assert = require('node:assert/strict');
const { createBenchClient } = require('../src/bench');
const { createClient } = require('../src/core');
(async () => {
    const calls = [];
    const board = { schema: 'bench.ratings@1', kind_id: 'design.page', minimum_samples: 20, rows: [] };
    const bench = createBenchClient({ json: async (request) => { calls.push(request); return { board }; } }, { actingSubject: 'bad-on-purpose' });
    const signal = new AbortController().signal;
    assert.deepEqual(await bench.ratings.get('design.page', { category: 'writing', signal }), { board });
    assert.equal(calls[0].path, '/api/v1/ratings/design.page');
    assert.equal(calls[0].auth, false);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].query.category, 'writing');
    assert.equal(calls[0].signal, signal);
    assert.deepEqual(calls[0].headers, {});
    assert.throws(() => bench.ratings.get('design/page'), /kind id/);
    assert.throws(() => bench.ratings.get('design.page', { category: ['a', 'b'] }), /category/);
    const publicClient = createBenchClient(createClient({ fetch: async (_url, init) => {
        const headers = new Headers(init.headers);
        assert(!headers.has('authorization') && !headers.has('x-ov-subject'));
        return new Response(JSON.stringify({ board }), { headers: { 'Content-Type': 'application/json' } });
    }, auth: { getToken: async () => { throw new Error('Public ratings must not request a token'); } } }), { baseUrl: 'https://bench.example.test', actingSubject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
    assert.equal((await publicClient.ratings.get('design.page')).board.minimum_samples, 20);
    console.log('bench.ratings: public fitted reads preserve empty evidence, forward signals and send no identity');
})().catch((err) => { console.error(err); process.exitCode = 1; });
