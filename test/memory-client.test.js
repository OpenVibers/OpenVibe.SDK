'use strict';
// openvibe-sdk/memory: remember, recall and profile as calls to OpenVibe.AI's memory API, always for one person.
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createMemoryClient, KINDS, MEMORY_PAGE } = require('../src/memory');

const PERSON = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
const fake = () => {
    const calls = [];
    return { calls, json: async (opts) => { calls.push(opts); return { ok: true }; } };
};

run([
    ['remember: one POST to items:batch, on behalf of the person, scope user by default, kinds checked', async () => {
        const c = fake();
        const m = createMemoryClient(c);
        await m.remember(PERSON, [{ text: '  Prefers short answers ', kind: 'preference' }, 'Streams on Fridays']);
        const [x] = c.calls;
        assert.deepEqual([x.method, x.path, x.service, x.audience], ['POST', '/api/v1/memory/items:batch', 'ai', 'openvibe.ai']);
        assert.deepEqual(x.json, { on_behalf_of: PERSON, items: [{ text: 'Prefers short answers', scope: 'user', kind: 'preference' }, { text: 'Streams on Fridays', scope: 'user' }] });
        assert.equal(x.idempotencyKey, false, 'not retried unless the caller gives a key');
        await m.remember(PERSON, { text: 'x' }, { scope: 'project:p1', idempotencyKey: 'k1' });
        assert.deepEqual([c.calls[1].json.items[0].scope, c.calls[1].idempotencyKey], ['project:p1', 'k1']);
        await assert.rejects(() => m.remember(PERSON, [{ text: 'x', kind: 'gossip' }]), /kind is one of/);
        await assert.rejects(() => m.remember(PERSON, [{ text: '   ' }]), /no text/);
        await assert.rejects(() => m.remember(PERSON, []), /1 to 200/);
        await assert.rejects(() => m.remember('alex', ['x']), /usr_ subject/);
        assert.ok(KINDS.includes('fact') && KINDS.length === 6);
    }],
    ['recall and profile: GETs with the person and the scopes in the query; the page is openvibe.my/memory', async () => {
        const c = fake();
        const m = createMemoryClient(c, { baseUrl: 'http://ai.internal' });
        await m.recall(PERSON, 'how they like answers', { scopes: ['user', 'project:p1'] });
        await m.profile(PERSON);
        assert.deepEqual([c.calls[0].method, c.calls[0].path, c.calls[0].query], ['GET', '/api/v1/memory/search', { q: 'how they like answers', scopes: 'user,project:p1', on_behalf_of: PERSON }]);
        assert.deepEqual([c.calls[1].path, c.calls[1].query, c.calls[1].baseUrl], ['/api/v1/memory/profile', { scope: 'user', on_behalf_of: PERSON }, 'http://ai.internal']);
        await m.recall(PERSON, 'x');
        assert.equal(c.calls[2].query.scopes, 'user');
        assert.equal(MEMORY_PAGE, 'https://openvibe.my/memory');
        assert.throws(() => createMemoryClient({}), /needs an openvibe-sdk client/);
    }],
]);
