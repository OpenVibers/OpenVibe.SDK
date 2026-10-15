'use strict';
// openvibe-sdk/quest: app quests on OpenVibe.Quest (contracts 0.193.0): the routes, the audience, and the event types an
// app publishes them under.
const assert = require('assert');
const { createQuestClient, eventType, projectKey } = require('../src/quest');

(async () => {
    const calls = [];
    const client = { json: async (opts) => { calls.push(opts); return { ok: true }; } };
    const quest = createQuestClient(client, { baseUrl: 'http://quest.test' });
    const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';

    assert.strictEqual(projectKey(PRJ), 'p01jab2c3d4e5f6g7h8j9k0mnpq');
    assert.strictEqual(eventType(PRJ, 'gem.found'), 'app.p01jab2c3d4e5f6g7h8j9k0mnpq.gem.found');
    assert.throws(() => eventType('prj_x', 'gem'), /project id/);
    assert.throws(() => eventType(PRJ, 'Gem Found'), /segments/);

    const def = { title: 'Collector', steps: [{ event_type: eventType(PRJ, 'gem.found'), count: 5, label: 'Find a gem' }], badge: { name: 'Gem Collector' } };
    await quest.appQuests.define('collector', def);
    await quest.appQuests.list();
    await quest.appQuests.retire('collector');
    assert.deepStrictEqual(calls.map((c) => [c.method || 'GET', c.path, c.audience, c.service, c.baseUrl]), [
        ['PUT', '/api/v1/app-quests/collector', 'openvibe.quest', 'quest', 'http://quest.test'],
        ['GET', '/api/v1/app-quests', 'openvibe.quest', 'quest', 'http://quest.test'],
        ['DELETE', '/api/v1/app-quests/collector', 'openvibe.quest', 'quest', 'http://quest.test'],
    ]);
    assert.deepStrictEqual(calls[0].json, def);
    assert.throws(() => createQuestClient({}), /core client/);
    console.log('quest: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
