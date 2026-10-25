'use strict';
/**
 * Chat: paths, bodies and methods for global, rooms and DMs; writes never retried; a missing room is null. Inboxes,
 * feeds and Vibe go to their paths; the inbox visitor and the feed publisher send no account token and no cookies, the
 * visitor keeps its token, the publisher sends the feed's key and retries only batches whose events all have an id.
 */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createChatClient, createInboxVisitor, createFeedPublisher } = require('../src/chat');

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
    ['inboxes, feeds and Vibe go to their paths', async () => {
        const srv = await chatStub();
        const chat = createChatClient(createClient({ baseUrls: { chat: srv.url }, token: 'user-jwt' }));
        await chat.inboxes.create({ name: 'Acme' });
        await chat.inboxes.conversations('inb_X', { status: 'waiting' });
        await chat.inboxes.reply('inb_X', 'cnv_Y', 'On its way');
        await chat.inboxes.setStatus('inb_X', 'cnv_Y', 'resolved');
        await chat.feeds.create({ title: 'Building', slot: 77 });
        await chat.feeds.rotateKey('fed_Z');
        await chat.feeds.view('fed_Z', { limit: 5 });
        await chat.feeds.onLive({ slot: [77, 78] });
        await chat.vibe.start('hello');
        await chat.inboxes.saveReply('inb_X', 'refund', 'Five days.');
        await chat.inboxes.addWebhook('inb_X', 'https://hooks.slack.com/services/x');
        await chat.inboxes.assign('inb_X', 'cnv_Y', 7);
        await chat.inboxes.addAction('inb_X', { name: 'look_up_order', description: 'Finds an order.', url: 'https://shop.example/vibe', params: 'order_id: the number' });
        await chat.inboxes.testAction('inb_X', 3, { order_id: '42' });
        const got = srv.requests.map((r) => [r.method, r.url, r.body && String(r.body).length ? JSON.parse(String(r.body)) : null]);
        assert.deepEqual(got, [
            ['POST', '/api/chat/inboxes', { name: 'Acme' }],
            ['GET', '/api/chat/inboxes/inb_X/conversations?status=waiting', null],
            ['POST', '/api/chat/inboxes/inb_X/conversations/cnv_Y/messages', { message: 'On its way' }],
            ['PATCH', '/api/chat/inboxes/inb_X/conversations/cnv_Y', { status: 'resolved' }],
            ['POST', '/api/chat/feeds', { title: 'Building', slot: 77 }],
            ['POST', '/api/chat/feeds/fed_Z/key', null],
            ['GET', '/api/chat/feeds/fed_Z?limit=5', null],
            ['GET', '/api/chat/feeds?slot=77%2C78', null],
            ['POST', '/api/chat/vibe', { message: 'hello' }],
            ['POST', '/api/chat/inboxes/inb_X/replies', { shortcut: 'refund', body: 'Five days.' }],
            ['POST', '/api/chat/inboxes/inb_X/webhooks', { url: 'https://hooks.slack.com/services/x' }],
            ['PATCH', '/api/chat/inboxes/inb_X/conversations/cnv_Y', { assignee_id: 7 }],
            ['POST', '/api/chat/inboxes/inb_X/actions', { name: 'look_up_order', description: 'Finds an order.', url: 'https://shop.example/vibe', params: 'order_id: the number' }],
            ['POST', '/api/chat/inboxes/inb_X/actions/3/test', { arguments: { order_id: '42' } }],
        ]);
        assert.equal(srv.requests[6].headers.authorization, undefined, 'a feed is read without the person\'s token');
        await srv.close();
    }],
    ['an inbox visitor needs no account and keeps its token; a feed publisher sends the key', async () => {
        const INBOX = `inb_${'A'.repeat(26)}`; const FEED = `fed_${'B'.repeat(26)}`; const KEY = `ovf_${'k'.repeat(32)}`;
        let fails = 1;
        const srv = await stubServer((req, res) => {
            if (req.url.endsWith('/visit')) return send(res, 200, { token: 'T'.repeat(32), conversation: null, messages: [] });
            if (req.url.endsWith('/events') && fails-- > 0) return send(res, 503, { error: 'busy' });
            return send(res, 200, { ok: true });
        });
        const client = createClient({ baseUrls: { chat: srv.url }, token: 'someone-else', retries: 2 });
        const v = createInboxVisitor(client, { inbox: INBOX });
        await v.visit();
        assert.equal(v.token, 'T'.repeat(32));
        await v.send('hi', { page_url: 'https://shop.example/' });
        await v.messages({ after: 3 });
        await v.rate(1, { comment: 'Quick!' });
        assert.deepEqual(JSON.parse(String(srv.requests[3].body)), { token: 'T'.repeat(32), rating: 1, comment: 'Quick!' });
        const sent = srv.requests.slice(0, 3);
        assert.ok(sent.every((r) => r.headers.authorization === undefined), 'no account token');
        assert.deepEqual(JSON.parse(String(sent[1].body)), { token: 'T'.repeat(32), message: 'hi', page_url: 'https://shop.example/' });
        assert.equal(sent[2].headers['x-visitor-token'], 'T'.repeat(32));
        const signed = createInboxVisitor(client, { inbox: INBOX, user: { id: 'cust-42', hash: 'a'.repeat(64) } });
        await signed.visit();
        assert.deepEqual(JSON.parse(String(srv.requests[srv.requests.length - 1].body)).user, { id: 'cust-42', hash: 'a'.repeat(64) }, 'a verified visitor sends who they are');
        const mine = createInboxVisitor(client, { inbox: INBOX, account: 'net-jwt' });
        await mine.visit();
        assert.equal(srv.requests[srv.requests.length - 1].headers.authorization, 'Bearer net-jwt', 'a signed-in visitor sends their own sign-in');
        const f = createFeedPublisher(client, { feed: FEED, key: KEY });
        await f.publish([{ eventId: 'e1', eventType: 'prompt', text: 'x' }]);
        const pubs = srv.requests.filter((r) => r.url.endsWith('/events'));
        assert.equal(pubs.length, 2, 'a batch whose events all have ids is retried');
        assert.equal(pubs[0].headers.authorization, `Bearer ${KEY}`);
        fails = 1;
        await assert.rejects(f.publish({ eventType: 'prompt', text: 'no id' }), (e) => e.status === 503);
        assert.equal(srv.requests.filter((r) => r.url.endsWith('/events')).length, 3, 'one without ids is not');
        assert.throws(() => createFeedPublisher(client, { feed: FEED, key: 'hbt_x' }), TypeError);
        assert.throws(() => createInboxVisitor(client, { inbox: 'nope' }), TypeError);
        await srv.close();
    }],
]);
