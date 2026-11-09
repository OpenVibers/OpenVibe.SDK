'use strict';
const assert = require('node:assert/strict');
const { createReportClient } = require('../src/report');
const { createExchangeClient } = require('../src/exchange');

(async () => {
    const calls = [];
    const client = { json: async (opts) => { calls.push(opts); return {}; } };
    const report = createReportClient(client, { baseUrl: 'https://report.test' });
    await report.ai.leaderboard({ kind: 'code', limit: 10 });
    await report.ai.model('org/model');
    await report.ai.providers();
    await report.ai.compare(['a', 'b']);
    await report.ai.picks();
    assert.equal(calls.length, 5);
    assert.equal(calls[0].path, '/api/v1/ai/leaderboard');
    assert.deepEqual(calls[3].query, { models: 'a,b' });
    assert.throws(() => report.ai.model(''), /id is required/);

    const requests = [];
    const exchange = createExchangeClient({ developerKey: 'test-key', baseUrl: 'https://exchange.test', fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }, maxRetries: 0 });
    await exchange.arena.start({ prompt: 'Compare', entries: [{ id: 'a' }, { id: 'b' }] });
    await exchange.arena.vote('rnd_1', 'left');
    assert.match(requests[0].url, /\/api\/v1\/arena\/rounds$/);
    assert.match(requests[1].url, /\/api\/v1\/arena\/rounds\/rnd_1\/votes$/);
    await assert.rejects(exchange.arena.vote('rnd_1', 'bad'), /choice must be/);
    console.log('Report AI and Exchange Arena SDK tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
