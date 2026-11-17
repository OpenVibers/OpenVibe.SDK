'use strict';
// openvibe-sdk/agents/roads: the one order every agent surface routes a turn by (plan §AD.17).
const assert = require('node:assert/strict');
const roads = require('../src/agents/roads');

const left = (n, extra = {}) => ({ unlimited: false, tokens: 20000, left: n, resets_at: '2026-11-18T00:00:00Z', ...extra });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the order is choice, free, key, computer', () => {
    assert.deepEqual(roads.ROADS, ['choice', 'free', 'key', 'computer']);
    assert.equal(roads.needFor('agent'), 12000);
    assert.equal(roads.needFor('auto', { turnTokens: 8000 }), 8000);
    assert.equal(roads.needFor('chat'), 1);
    assert.equal(roads.needFor('code'), 0);
    assert.equal(roads.needFor('nonsense'), 12000, 'an unknown mode is Auto');
});

test('the person\'s own pick comes first, whatever is left', () => {
    const r = roads.pick({ mode: 'agent', allowance: left(0), choice: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    assert.equal(r.road, 'choice');
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.deepEqual(r.ladder.map((s) => [s.road, s.open]), [['choice', true]]);
});

test('free when the turn fits, and when the allowance is not known or has no cap', () => {
    assert.equal(roads.pick({ mode: 'agent', allowance: left(15000) }).road, 'free');
    const unknown = roads.pick({ mode: 'agent', allowance: null });
    assert.deepEqual([unknown.road, unknown.known], ['free', false]);
    assert.equal(roads.pick({ mode: 'agent', allowance: { unlimited: true } }).road, 'free');
});

test('an agent turn that cannot fit goes to the key allowed for this app, then an online computer', () => {
    const keys = [{ provider: 'openai', apps: ['chat'] }, { provider: 'deepseek', status: 'revoked', apps: ['actor'] }, { provider: 'anthropic', apps: ['actor'] }];
    const k = roads.pick({ mode: 'agent', allowance: left(4000), keys, app: 'actor' });
    assert.deepEqual([k.road, k.provider], ['key', 'anthropic'], 'not the key for another app, not a revoked one');
    assert.match(k.why, /4k tokens left today, a turn like this takes about 12k, so your anthropic key takes it/);
    const machines = [{ id: 'm1', name: 'Desk', online: false }, { id: 'm2', name: 'Laptop', online: true, disabled: true }, { id: 'm3', name: 'Tower', online: true }];
    const c = roads.pick({ mode: 'agent', allowance: left(0), keys: [{ provider: 'openai', apps: ['chat'] }], machines, app: 'actor' });
    assert.deepEqual([c.road, c.machine], ['computer', { id: 'm3', name: 'Tower' }]);
    assert.deepEqual(c.ladder.map((s) => [s.road, s.open]), [['choice', false], ['free', false], ['key', false], ['computer', true]]);
});

test('nothing open: says why, when it comes back, and whether Chat would still answer', () => {
    const some = roads.pick({ mode: 'agent', allowance: left(3000) });
    assert.deepEqual([some.road, some.chat_only, some.left, some.resets_at], ['none', true, 3000, '2026-11-18T00:00:00Z']);
    assert.match(roads.say(some), /3k tokens left today: enough for Chat, not for an agent turn/);
    const chat = roads.pick({ mode: 'chat', allowance: left(3000) });
    assert.equal(chat.road, 'free', 'Chat\'s one model answers with anything left');
    const none = roads.pick({ mode: 'chat', allowance: left(0) });
    assert.deepEqual([none.road, none.chat_only], ['none', false]);
    assert.match(roads.say(none), /used up for today/);
});

test('a coding run is Codes\' own', () => {
    const r = roads.pick({ mode: 'code', allowance: left(0) });
    assert.equal(r.road, 'code');
    assert.deepEqual(r.ladder, []);
});

test('walk asks each rung only when it is reached, and a rung may take the road', async () => {
    const asked = [];
    const r = await roads.walk({
        mode: 'agent',
        choice: async () => { asked.push('choice'); return null; },
        allowance: async () => { asked.push('free'); return left(500); },
        key: async () => { asked.push('key'); return null; },
        computer: async () => { asked.push('computer'); return { task: 't_1', on: 'Tower' }; },
    });
    assert.deepEqual(asked, ['choice', 'free', 'key', 'computer']);
    assert.deepEqual([r.road, r.value], ['computer', { task: 't_1', on: 'Tower' }]);
    const early = [];
    const free = await roads.walk({ mode: 'agent', allowance: () => { early.push('free'); return left(20000); }, key: () => { early.push('key'); return { provider: 'x' }; } });
    assert.deepEqual([free.road, early], ['free', ['free']], 'the key is never asked when the free AI fits');
});

test('walk: a rung that throws is closed with its reason; a missing rung is not listed', async () => {
    const r = await roads.walk({ mode: 'agent', allowance: () => left(0), key: () => { throw new Error('AI did not answer'); } });
    assert.equal(r.road, 'none');
    assert.deepEqual(r.ladder.map((s) => s.road), ['free', 'key']);
    assert.match(r.ladder[1].why, /could not be asked: AI did not answer/);
    const k = await roads.walk({ mode: 'agent', allowance: left(0), key: { provider: 'deepseek', subject: 'user:x' } });
    assert.deepEqual([k.road, k.provider, k.value.subject], ['key', 'deepseek', 'user:x']);
    assert.match(roads.say(k), /^Your deepseek key answers: the free allowance is used up today\.$/);
});

(async () => {
    for (const [name, fn] of tests) { await fn(); console.log(`  ✓ ${name}`); }
    console.log('agents-roads: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
