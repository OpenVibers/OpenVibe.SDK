'use strict';
const assert = require('assert');
const { createHistoryClient } = require('../src/history');

(async () => {
    const calls = [];
    const history = createHistoryClient({ json: async (args) => { calls.push(args); return args; } }, { baseUrl: 'https://network.test' });
    await history.list({ limit: 12, kind: 'video', cursor: 'next' });
    assert.deepStrictEqual(calls.pop(), { service: 'network', baseUrl: 'https://network.test', path: '/api/v1/history', query: { limit: 12, kind: 'video', cursor: 'next' }, signal: undefined });
    await history.find('a fox video');
    assert.deepStrictEqual(calls.pop().query, { q: 'a fox video', limit: undefined });
    await history.agentRecent({ limit: 7 });
    assert.strictEqual(calls.pop().path, '/api/v1/history/agents/recent');
    await history.removeDay('2026-11-10');
    assert.strictEqual(calls.pop().path, '/api/v1/history/day/2026-11-10');
    await history.settings({ agents_allowed: true });
    assert.deepStrictEqual(calls.pop().json, { agents_allowed: true });
    console.log('history SDK client: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
