'use strict';
const assert = require('node:assert/strict');
const { createAiClient } = require('../src/ai');
const { createClient } = require('../src/core');
(async () => {
    const calls = [];
    const cell = { latency_p50_ms: 1000, ttft_p50_ms: null, runs: 20 };
    const ai = createAiClient({ json: async (r) => { calls.push(r); return { series: [cell] }; } });
    const signal = new AbortController().signal;
    await ai.metrics.status();
    assert.equal((await ai.metrics.model('openai/gpt-5-mini', { days: 90 }, { signal })).series[0].ttft_p50_ms, null);
    await ai.metrics.compare({ models: ['openai/gpt-5-mini', 'openai/gpt-5-nano'], measures: ['latency_p50_ms'], kind: 'chat' });
    await ai.metrics.leaderboard({ kind: 'code', measure: 'cost_per_run_usd' });
    await ai.metrics.prices('openai/gpt-5-mini', { days: 30 });
    await ai.metrics.providerHealth('openai');
    assert(calls.every((r) => r.auth === false && r.method === 'GET'));
    assert.equal(calls[1].path, '/api/v1/exchange/metrics/models/openai%2Fgpt-5-mini');
    assert.equal(calls[1].signal, signal);
    assert.equal(calls[2].query.models, 'openai/gpt-5-mini,openai/gpt-5-nano');
    assert.equal(calls[2].query.measures, 'latency_p50_ms');
    assert.throws(() => ai.metrics.compare({ models: Array(7).fill('a/b') }), /six models/);
    assert.throws(() => ai.metrics.model('../bad?query'), /slug/);
    const live = createAiClient(createClient({ fetch: async (_url, init) => {
        assert(!new Headers(init.headers).has('authorization'));
        return new Response(JSON.stringify({ series: [cell] }), { headers: { 'Content-Type': 'application/json' } });
    }, auth: { getToken: async () => { throw new Error('public metrics must not ask for a token'); } } }), { baseUrl: 'https://ai.example.test' });
    assert.equal((await live.metrics.model('openai/gpt-5-mini')).series[0].latency_p50_ms, 1000);
    console.log('ai.metrics: typed public reads preserve nulls, encode paths, forward signals and never request credentials');
})().catch((err) => { console.error(err); process.exitCode = 1; });
