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
    };
}

module.exports = { createChatClient };
