'use strict';
/**
 * openvibe-sdk/chat: OpenVibe.Chat over REST (roadmap WS-F task 4): global chat, rooms and direct
 * messages, for bots and apps. Browser-safe. Live delivery is Chat's WebSocket (/ws/chat); this is the
 * REST side of the same data.
 *
 *   const chat = createChatClient(client);            // a signed-in person's token, or an API token
 *   await chat.global.send('hello');
 *   const room = await chat.rooms.create({ name: 'Builders' });
 *   await chat.rooms.send(room.room.slug, 'first!');
 *   const dm = await chat.dms.create([42]);
 *   await chat.dms.send(dm.conversation.id, 'hi');
 *
 * Every call acts as the token's person (Chat has no service acting-for-someone mode). Writes are never
 * retried (Chat does not deduplicate them); reads are. A missing or unreadable room or conversation is
 * null from get().
 *
 * The rest of Chat as a platform (Chat's docs/platform.md): `vibe` (a person's chats with Vibe, OpenVibe's
 * assistant), `inboxes` (support inboxes: the team's side) and `feeds` (live activity such as vibe coding: the
 * owner's side). Two clients need no account at all and answer from any site, without cookies:
 *
 *   const visitor = createInboxVisitor(client, { inbox: 'inb_…', token: saved });   // build your own chat panel
 *   const { token } = await visitor.visit();                                        // keep it: it is the visitor
 *   await visitor.send('Where is my order?', { page_url: location.href });
 *
 *   const feed = createFeedPublisher(client, { feed: 'fed_…', key: feedKey });              // the feed's ovf_ key
 *   await feed.publish({ eventType: 'prompt', text: 'Add a dark mode' });           // or a list, or Live's envelopes
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;

function createChatClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const call = (opts, o = {}) => client.json({ service: 'chat', baseUrl, audience: 'openvibe.chat', ...opts, signal: o.signal });
    const once = { idempotencyKey: false };
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && (err.status === 404 || err.status === 403)) return null; throw err; });
    const room = (slug) => `/api/chat/rooms/${enc(slug)}`;
    const conv = (id) => `/api/dm/conversations/${enc(id)}`;
    const inbox = (id) => `/api/chat/inboxes/${enc(id)}`;
    const feed = (id) => `/api/chat/feeds/${enc(id)}`;

    return {
        global: {
            /** { messages, … } — the global feed; query: limit, after_id (a delta after a message id). */
            history: (query = {}, o = {}) => call({ path: '/api/chat/global/history', query }, o),
            /** Post to global chat as the token's person. { message: string, reply_to_id?, auto_delete_minutes? } */
            send: (message, extra = {}, o = {}) => call({ method: 'POST', path: '/api/chat/send', json: { message, ...extra }, ...once }, o),
            /** Your own lines (staff with staff.moderation.logs may pass user_id). query: q, user_id, stream_id, limit, offset */
            search: (query = {}, o = {}) => call({ path: '/api/chat/search', query }, o),
        },
        rooms: {
            list: (o = {}) => call({ path: '/api/chat/rooms' }, o),
            create: (input, o = {}) => call({ method: 'POST', path: '/api/chat/rooms', json: input, ...once }, o),
            get: (slug, o = {}) => orNull(call({ path: room(slug) }, o)),
            update: (slug, patch, o = {}) => call({ method: 'PATCH', path: room(slug), json: patch, ...once }, o),
            /** query: before | after (message id), limit */
            messages: (slug, query = {}, o = {}) => call({ path: `${room(slug)}/messages`, query }, o),
            send: (slug, message, o = {}) => call({ method: 'POST', path: `${room(slug)}/messages`, json: { message }, ...once }, o),
            deleteMessage: (slug, id, o = {}) => call({ method: 'DELETE', path: `${room(slug)}/messages/${enc(id)}`, ...once }, o),
            join: (slug, o = {}) => call({ method: 'POST', path: `${room(slug)}/join`, ...once }, o),
            leave: (slug, o = {}) => call({ method: 'POST', path: `${room(slug)}/leave`, ...once }, o),
            read: (slug, lastId, o = {}) => call({ method: 'POST', path: `${room(slug)}/read`, json: lastId != null ? { last_id: lastId } : {}, ...once }, o),
            members: (slug, o = {}) => call({ path: `${room(slug)}/members` }, o),
            /** Owners and moderators: role member | mod | blocked | none */
            setMember: (slug, username, role, o = {}) => call({ method: 'POST', path: `${room(slug)}/members`, json: { username, role }, ...once }, o),
        },
        dms: {
            list: (o = {}) => call({ path: '/api/dm/conversations' }, o),
            /** A 1:1 conversation is reused; more ids make a group ({ name }). */
            create: (userIds, extra = {}, o = {}) => call({ method: 'POST', path: '/api/dm/conversations', json: { user_ids: userIds, ...extra }, ...once }, o),
            get: (id, o = {}) => orNull(call({ path: conv(id) }, o)),
            /** query: limit, before */
            messages: (id, query = {}, o = {}) => call({ path: `${conv(id)}/messages`, query }, o),
            send: (id, message, o = {}) => call({ method: 'POST', path: `${conv(id)}/messages`, json: { message }, ...once }, o),
            deleteMessage: (id, msgId, o = {}) => call({ method: 'DELETE', path: `${conv(id)}/messages/${enc(msgId)}`, ...once }, o),
            read: (id, o = {}) => call({ method: 'POST', path: `${conv(id)}/read`, ...once }, o),
            unread: (o = {}) => call({ path: '/api/dm/unread' }, o),
            blocks: (o = {}) => call({ path: '/api/dm/blocks' }, o),
            block: (userId, o = {}) => call({ method: 'POST', path: `/api/dm/blocks/${enc(userId)}`, ...once }, o),
            unblock: (userId, o = {}) => call({ method: 'DELETE', path: `/api/dm/blocks/${enc(userId)}`, ...once }, o),
        },
        /** Every message you sent that is still visible: { username, total, truncated, messages } (JSON). */
        exportMine: (o = {}) => call({ path: '/api/chat/me/export' }, o),
        /** Vibe, OpenVibe's assistant: the person's chats with it (people only; an API token gets 403). */
        vibe: {
            /** { chats, allowance } */
            list: (o = {}) => call({ path: '/api/chat/vibe' }, o),
            /** A new chat; Vibe answers in its room (rooms.messages, or the room socket). → { room, message } */
            start: (message, o = {}) => call({ method: 'POST', path: '/api/chat/vibe', json: { message }, ...once }, o),
            rename: (slug, name, o = {}) => call({ method: 'PATCH', path: `/api/chat/vibe/${enc(slug)}`, json: { name }, ...once }, o),
            remove: (slug, o = {}) => call({ method: 'DELETE', path: `/api/chat/vibe/${enc(slug)}`, ...once }, o),
        },
        /** Support inboxes, the team's side: Vibe answers visitors first, the inbox's people take over. */
        inboxes: {
            /** { inboxes }: those you work in, with waiting and open counts */
            list: (o = {}) => call({ path: '/api/chat/inboxes' }, o),
            /** → { inbox, embed: { script, panel } }; embed.script is the one tag a site adds */
            create: (input, o = {}) => call({ method: 'POST', path: '/api/chat/inboxes', json: input, ...once }, o),
            get: (id, o = {}) => orNull(call({ path: inbox(id) }, o)),
            update: (id, patch, o = {}) => call({ method: 'PATCH', path: inbox(id), json: patch, ...once }, o),
            remove: (id, o = {}) => call({ method: 'DELETE', path: inbox(id), ...once }, o),
            addMember: (id, username, o = {}) => call({ method: 'POST', path: `${inbox(id)}/members`, json: { username }, ...once }, o),
            removeMember: (id, userId, o = {}) => call({ method: 'DELETE', path: `${inbox(id)}/members/${enc(userId)}`, ...once }, o),
            /** query: status = active | bot | waiting | open | resolved → { conversations } (waiting first) */
            conversations: (id, query = {}, o = {}) => call({ path: `${inbox(id)}/conversations`, query }, o),
            /** query: after (a message id) → { conversation, messages } */
            messages: (id, convId, query = {}, o = {}) => call({ path: `${inbox(id)}/conversations/${enc(convId)}/messages`, query }, o),
            /** A person's answer: the conversation becomes open and Vibe stays quiet in it. */
            reply: (id, convId, message, o = {}) => call({ method: 'POST', path: `${inbox(id)}/conversations/${enc(convId)}/messages`, json: { message }, ...once }, o),
            /** status: open | resolved | bot (back to Vibe) */
            setStatus: (id, convId, status, o = {}) => call({ method: 'PATCH', path: `${inbox(id)}/conversations/${enc(convId)}`, json: { status }, ...once }, o),
            read: (id, convId, o = {}) => call({ method: 'POST', path: `${inbox(id)}/conversations/${enc(convId)}/read`, ...once }, o),
        },
        /** Feeds, the owner's side (publishing is createFeedPublisher, with the feed's key). */
        feeds: {
            mine: (o = {}) => call({ path: '/api/chat/feeds/mine' }, o),
            /** { title?, room?, slot?, settings? } → { feed, key }: the key is shown only this once */
            create: (input = {}, o = {}) => call({ method: 'POST', path: '/api/chat/feeds', json: input, ...once }, o),
            update: (id, patch, o = {}) => call({ method: 'PATCH', path: feed(id), json: patch, ...once }, o),
            /** A new key; the old one stops working. → { key } */
            rotateKey: (id, o = {}) => call({ method: 'POST', path: `${feed(id)}/key`, ...once }, o),
            remove: (id, o = {}) => call({ method: 'DELETE', path: feed(id), ...once }, o),
            /** What a viewer sees now (after the feed's delay): { feed, publisher, events }. Anyone may read it. */
            view: (id, query = {}, o = {}) => orNull(call({ path: feed(id), query, auth: false, credentials: 'omit' }, o)),
            /** The feeds shown on Live channel slots: { slot: [ids] } or { channel: username } → { feeds } */
            onLive: (where, o = {}) => call({ path: '/api/chat/feeds', query: where.channel ? { channel: where.channel } : { slot: [].concat(where.slot || []).join(',') }, auth: false, credentials: 'omit' }, o),
        },
    };
}

/**
 * A support inbox's visitor, for a site that builds its own panel instead of openvibe.chat/widget.js. No account and
 * no cookies: the visitor is the token visit() returns, which the site keeps (and passes back next time to resume the
 * conversation). An inbox that names its allowed sites answers only them. Writes are not retried.
 *
 * user (an inbox with verified visitors): { id, name?, email?, hash } where hash is HMAC-SHA256 of id with the inbox's
 * identity secret, in hex, made on your server; Chat then trusts the name and email and gives the person the same
 * token on every device. A wrong hash is just an anonymous visitor.
 */
function createInboxVisitor(client, { inbox, token = null, user = null, baseUrl } = {}) {
    if (!/^inb_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(inbox || ''))) throw new TypeError('createInboxVisitor: inbox is an inb_ id');
    let current = token || null;
    const call = (opts, o = {}) => client.json({ service: 'chat', baseUrl, auth: false, credentials: 'omit', ...opts, signal: o.signal });
    const path = (p = '') => `/api/chat/widget/inbox/${enc(inbox)}${p}`;
    const once = { idempotencyKey: false };
    return {
        /** The visitor's token (null before the first visit). */
        get token() { return current; },
        /** { inbox }: name, greeting, color, whether Vibe answers */
        config: (o = {}) => call({ path: path() }, o),
        /** → { token, inbox, conversation, messages }; a missing or unknown token gets a new one */
        visit: async (o = {}) => { const d = await call({ method: 'POST', path: path('/visit'), json: { token: current, ...(user ? { user } : {}) }, ...once }, o); current = d.token; return d; },
        /** extra: page_url, name → { conversation, message }; after a resolved conversation this starts a new one */
        send: (message, extra = {}, o = {}) => call({ method: 'POST', path: path('/messages'), json: { token: current, message, ...(user ? { user } : {}), ...extra }, ...once }, o),
        /** query: after (a message id) → { conversation, messages } */
        messages: (query = {}, o = {}) => call({ path: path('/messages'), query, headers: { 'X-Visitor-Token': current } }, o),
        /** "Talk to a person" → { conversation } (409 when only Vibe answers in this inbox: config().inbox.people false) */
        handoff: (o = {}) => call({ method: 'POST', path: path('/handoff'), json: { token: current }, ...once }, o),
        /** Rate a resolved conversation: 1 (good) or -1 (bad), with a line → { conversation } */
        rate: (rating, extra = {}, o = {}) => call({ method: 'POST', path: path('/rating'), json: { token: current, rating, ...extra }, ...once }, o),
    };
}

/**
 * Publish to a feed with its key (ovf_…, from feeds.create or the feed's page on openvibe.chat). Events are Live's
 * canonical vibe coding events: eventType session.status | prompt | response | thinking | tool.call | file.change |
 * file.save, with eventId, sessionKey, summary and the type's part ({ prompt: { text } }, { tool: { name } }, …); a short
 * { eventType, text } works too. Chat scrubs secrets and home folders before anything is stored. A batch whose events
 * all carry an eventId is retried (Chat stores an eventId once); otherwise it is not.
 */
function createFeedPublisher(client, { feed, key, baseUrl } = {}) {
    if (!/^fed_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(feed || ''))) throw new TypeError('createFeedPublisher: feed is a fed_ id');
    if (!/^ovf_[A-Za-z0-9_-]{32}$/.test(String(key || ''))) throw new TypeError('createFeedPublisher: key is the feed\'s ovf_ key');
    const call = (opts, o = {}) => client.json({ service: 'chat', baseUrl, auth: false, credentials: 'omit', headers: { Authorization: `Bearer ${key}` }, ...opts, signal: o.signal });
    const path = (p) => `/api/chat/feeds/${enc(feed)}${p}`;
    const hasId = (e) => !!(e && (e.eventId || (e.event && e.event.eventId)));
    return {
        /** { sessionKey?, publisher?: { integrationId, integrationLabel, clientName, … } } → { sessionKey, publisher } */
        hello: (input = {}, o = {}) => call({ method: 'POST', path: path('/hello'), json: input, idempotencyKey: false }, o),
        /** One event or a list (at most 50) → { events: [{ eventId, delivered }] } */
        publish: (events, o = {}) => {
            const list = Array.isArray(events) ? events : [events];
            return call({ method: 'POST', path: path('/events'), json: { events: list }, ...(list.every(hasId) ? { idempotent: true } : { idempotencyKey: false }) }, o);
        },
        /** Claude Code's hook JSON as it is (what an "http" hook posts) → {} */
        claudeCode: (hook, o = {}) => call({ method: 'POST', path: path('/hooks/claude-code'), json: hook, idempotencyKey: false }, o),
    };
}

module.exports = { createChatClient, createInboxVisitor, createFeedPublisher };
