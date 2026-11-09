'use strict';
const assert = require('node:assert/strict');
const { createQuestClient } = require('../src/quest');

const calls = [];
const client = createQuestClient({ json: async (opts) => { calls.push(opts); return { ok: true }; } });
(async () => {
    await client.daily();
    await client.daily({ date: '2026-11-08' });
    await client.myDaily();
    await client.stepTypes();
    await client.contributeStepType({ id: 'chat', event_type: 'chat.room.message.created', site: 'openvibe.chat', sentence: 'Chat', href: 'https://openvibe.chat/' });
    assert.deepEqual(calls.map((x) => [x.method || 'GET', x.path]), [
        ['GET', '/api/v1/daily'], ['GET', '/api/v1/daily/2026-11-08'], ['GET', '/api/v1/me/daily'],
        ['GET', '/api/v1/step-types'], ['POST', '/api/v1/step-types'],
    ]);
    assert.equal(calls[4].audience, 'openvibe.quest');
    assert.equal(calls[4].json.site, 'openvibe.chat');
    assert.equal(calls[4].idempotencyKey, false);
    process.stdout.write('quest daily SDK methods passed\n');
})().catch((err) => { process.stderr.write(String(err.stack || err) + '\n'); process.exit(1); });
