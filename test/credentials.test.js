'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const { createCredentialsClient } = require('../src/credentials');

t.test('credentials client uses person-scoped metadata and balance endpoints', async () => {
    const calls = [];
    const client = { json: async (request) => { calls.push(request); return { credentials: [] }; } };
    const api = createCredentialsClient(client, { baseUrl: 'https://ai.example' });
    await api.list(); await api.add({ provider: 'openai', cookie: 'private' }); await api.balance('id/one'); await api.remove('id/one');
    assert.deepEqual(calls.map((x) => [x.method, x.path]), [
        ['GET', '/api/v1/me/credentials'], ['POST', '/api/v1/me/credentials'],
        ['GET', '/api/v1/me/credentials/id%2Fone/balance'], ['DELETE', '/api/v1/me/credentials/id%2Fone'],
    ]);
    assert.ok(calls.every((x) => x.audience === 'openvibe.ai' && x.baseUrl === 'https://ai.example'));
});
