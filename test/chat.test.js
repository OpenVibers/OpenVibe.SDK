'use strict';
/** Chat: paths, bodies and methods for global, rooms and DMs; writes never retried; a missing room is null. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createChatClient } = require('../src/chat');

async function chatStub() {
    let busy = 0;
    return stubServer((req, res) => {
        if (req.url.startsWith('/api/chat/rooms/private-one')) return send(res, 404, { error: 'Room not found' });
        if (req.url === '/api/chat/send' && busy++ === 0) return send(res, 503, { error: 'busy' });
        return send(res, 200, { ok: true, url: req.url });
    });
}

run([
    ['global, rooms and DMs go to the right paths with the right bodies', async () => {
        const srv = await chatStub();
        const chat = createChatClient(createClient({ baseUrls: { chat: srv.url }, token: 'user-jwt', retries: 2 }));
        await chat.rooms.create({ name: 'Builders' });
        await chat.rooms.send('builders', 'first!');
        await chat.rooms.read('builders', 12);
        await chat.rooms.setMember('builders', 'bob', 'mod');
        await chat.dms.create([42], { name: 'pair' });
        await chat.dms.send(7, 'hi');
        await chat.dms.messages(7, { limit: 20 });
        await chat.global.history({ after_id: 5 });
        const got = srv.requests.map((r) => [r.method, r.url, r.body && String(r.body).length ? JSON.parse(String(r.body)) : null]);
        assert.deepEqual(got, [
            ['POST', '/api/chat/rooms', { name: 'Builders' }],
            ['POST', '/api/chat/rooms/builders/messages', { message: 'first!' }],
            ['POST', '/api/chat/rooms/builders/read', { last_id: 12 }],
            ['POST', '/api/chat/rooms/builders/members', { username: 'bob', role: 'mod' }],
            ['POST', '/api/dm/conversations', { user_ids: [42], name: 'pair' }],
            ['POST', '/api/dm/conversations/7/messages', { message: 'hi' }],
            ['GET', '/api/dm/conversations/7/messages?limit=20', null],
            ['GET', '/api/chat/global/history?after_id=5', null],
        ]);
        assert.equal(srv.requests[0].headers.authorization, 'Bearer user-jwt');
        await srv.close();
    }],
    ['a failed send is not retried; a room you may not read is null', async () => {
        const srv = await chatStub();
        const chat = createChatClient(createClient({ baseUrls: { chat: srv.url }, token: 't', retries: 2 }));
        await assert.rejects(chat.global.send('hello'), (e) => e.status === 503);
        assert.equal(srv.requests.filter((r) => r.url === '/api/chat/send').length, 1, 'one attempt only');
        assert.equal(await chat.rooms.get('private-one'), null);
        await srv.close();
    }],
]);
