'use strict';
/**
 * openvibe-sdk/live — OpenVibe.Live for apps and tools: who is live, channels, slots (managed streams), going live and
 * ending a session, ingest endpoints, WHIP publishing, and the content feeds. These are the routes the site's own pages
 * use, documented at https://openvibe.live/documentation and https://openvibe.live/docs/whip. Signed calls carry the
 * person's Network token (Live checks the issuer); the discovery reads need none.
 *
 *   const live = createLiveClient(createClient({ tokenProvider }));
 *   const now = await live.streams.list();                                   // everyone live right now
 *   const channel = await live.channels.get('goosely');                      // the channel page's data
 *   const { managed_stream: slot } = await live.slots.create({ title: 'Robot cam', streaming_method: 'whip' });
 *   const target = await live.whip.forSlot(slot.id);                        // → { url, key, authority } from the slot's profile
 *   const { stream, endpoint } = await live.goLive(slot.id, { title: 'Live now' });
 *   const session = await live.whip.publish(live.whip.url(slot.stream_key), offerSdp);   // → { answer, location }
 *   await live.whip.end(session.location);                                   // the last session ends the stream
 *   const page = await live.content.feed({ type: 'vods', sort: 'new' });     // recordings link to openvibe.video
 *
 * A slot is a saved setup with its own stream key; a stream is one live session started from it (POST /api/streams).
 * WHIP (docs/whip): POST an SDP offer to /whip/<stream key> (or /whip/<slot id> with the key as a bearer); the answer
 * comes back with a Location to DELETE when done. Errors are OpenVibeError (status, code); WHIP errors carry Live's
 * code (invalid_stream_key, slot_not_found, …).
 */
const enc = encodeURIComponent;
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;
const FEEDS = { content: '/api/content/feed', moments: '/api/content/moments' };

function createLiveClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') throw new TypeError('createLiveClient: pass an openvibe-sdk/core client');
    const at = { service: 'live', baseUrl, audience: 'openvibe.live' };
    // Writes are never retried on their own: Live keys no request by Idempotency-Key, and a second go-live or slot is
    // a second one.
    const call = ({ method = 'GET', ...opts }) => client.json({ ...at, method, ...(method === 'GET' ? {} : { idempotencyKey: false }), ...opts });
    const user = (username) => {
        const u = String(username || '').replace(/^@/, '');
        if (!USERNAME_RE.test(u)) throw new TypeError('live: a username is 1–32 letters, digits or _');
        return u;
    };
    const id = (v, what) => {
        if (!/^\d{1,15}$/.test(String(v))) throw new TypeError(`live: ${what} is a number`);
        return String(v);
    };
    const origin = async () => (baseUrl ? String(baseUrl).replace(/\/+$/, '') : await client.origin('live'));

    const streams = {
        /** Everyone live now, with external viewer totals. */
        list: ({ signal } = {}) => call({ path: '/api/streams', signal }),
        /** One stream (+ its endpoint while live, controls and cameras; keys stripped). */
        get: (streamId, { signal } = {}) => call({ path: `/api/streams/${id(streamId, 'a stream id')}`, signal }),
        /** Streamers grouped with their slots, most recently online first. */
        recentlyOnline: ({ signal } = {}) => call({ path: '/api/streams/recently-online', signal }),
        /** The signed-in person's streams. */
        mine: ({ signal } = {}) => call({ path: '/api/streams/mine', signal }),
        /** Title, description, category or tags of a live session (owner). */
        update: (streamId, patch, { signal } = {}) => call({ method: 'PUT', path: `/api/streams/${id(streamId, 'a stream id')}`, json: patch, signal }),
        /** End the session (owner): the recording finalises, restreams stop. */
        end: (streamId, { signal } = {}) => call({ method: 'DELETE', path: `/api/streams/${id(streamId, 'a stream id')}`, signal }),
        /** Keepalive while broadcasting (the active ingest is what keeps a stream live). */
        heartbeat: (streamId, { signal } = {}) => call({ method: 'POST', path: `/api/streams/${id(streamId, 'a stream id')}/heartbeat`, signal }),
        /** The session's ingest endpoint and stream key, for its protocol (owner). */
        endpoint: (streamId, { signal } = {}) => call({ path: `/api/streams/${id(streamId, 'a stream id')}/endpoint`, signal }),
    };

    const slots = {
        /** The signed-in person's slots and their slot limit. */
        list: ({ signal } = {}) => call({ path: '/api/streams/managed', signal }),
        /** A new slot with its own stream key: { title, description, category, streaming_method (browser|whip|cli|rtmp), … }. */
        create: (slot, { signal } = {}) => call({ method: 'POST', path: '/api/streams/managed', json: slot, signal }),
        update: (slotId, patch, { signal } = {}) => call({ method: 'PUT', path: `/api/streams/managed/${id(slotId, 'a slot id')}`, json: patch, signal }),
        /** Delete a slot (409 while it is live). */
        remove: (slotId, { signal } = {}) => call({ method: 'DELETE', path: `/api/streams/managed/${id(slotId, 'a slot id')}`, signal }),
        /** A new stream key for the slot (the old one stops working). */
        regenerateKey: (slotId, { signal } = {}) => call({ method: 'POST', path: `/api/streams/managed/${id(slotId, 'a slot id')}/regenerate-key`, signal }),
        /**
         * A slot's settings and where to publish to it (owner) → { managed_stream, stream_key, whip_url_base, rtmp_url,
         * restream_destinations, … }. A slot OpenRestream ingests answers OpenRestream's own whip_url and rtmp_url and no key.
         */
        profile: (slotId, { signal } = {}) => call({ path: `/api/streams/managed/${id(slotId, 'a slot id')}/profile`, signal }),
    };

    /** Go live from a slot → { stream, endpoint }. opts: title, category, tags, is_nsfw. */
    const goLive = (slotId, opts = {}, { signal } = {}) => call({ method: 'POST', path: '/api/streams', json: { ...opts, managed_stream_id: Number(id(slotId, 'a slot id')) }, signal });

    const channels = {
        /** A channel page's data: streams, VODs, clips, panels and slots. */
        get: (username, { signal } = {}) => call({ path: `/api/streams/channel/${enc(user(username))}`, signal }),
        /** The signed-in person's own channel. */
        mine: ({ signal } = {}) => call({ path: '/api/streams/channel', signal }),
        update: (patch, { signal } = {}) => call({ method: 'PUT', path: '/api/streams/channel', json: patch, signal }),
        /** Follow, or unfollow when already following (it toggles). */
        toggleFollow: (username, { signal } = {}) => call({ method: 'POST', path: `/api/streams/channel/${enc(user(username))}/follow`, signal }),
        /** https://openvibe.live/@<username>: a channel's one address. */
        url: async (username) => `${await origin()}/@${user(username)}`,
    };

    const feed = (which) => ({ type, sort, window, cursor, limit, signal } = {}) => call({ path: FEEDS[which], query: { type, sort, window, cursor, limit }, signal });
    const content = {
        /** What people made: recordings, clips and pastes → { items, next, … } (recordings and clips link to openvibe.video). */
        feed: feed('content'),
        /** What the AI made (auto-clips, AI moments, recaps), each labelled AI-generated. */
        moments: feed('moments'),
    };

    const whip = {
        /**
         * Where a slot publishes, from its profile → { url, key, authority }: Live's WHIP origin with the slot's key, or
         * OpenRestream's own WHIP URL when it ingests the slot (key null: its URL carries it). Pass the result to publish().
         */
        forSlot: async (slotId, { signal } = {}) => {
            const p = await slots.profile(slotId, { signal });
            if (p && typeof p.whip_url === 'string' && p.whip_url) return { url: p.whip_url, key: null, authority: p.ingest_authority || 'openre' };
            const key = p && p.stream_key;
            if (!key || !p.whip_url_base) throw new TypeError('live.whip.forSlot: this slot has no WHIP address (OpenRestream unreachable, or WHIP is off)');
            return { url: `${String(p.whip_url_base).replace(/\/+$/, '')}/whip/${enc(key)}`, key, authority: 'live' };
        },
        /** The WHIP URL for a stream key (or a slot id, with the key sent as the bearer). */
        url: async (keyOrSlot) => {
            const k = String(keyOrSlot || '');
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(k)) throw new TypeError('live.whip.url: pass a stream key or a slot id');
            return `${await origin()}/whip/${enc(k)}`;
        },
        /**
         * POST an SDP offer → { answer, location }: the SDP answer, and the session's absolute resource URL (DELETE it
         * to stop). `key` is sent as the bearer (needed with a slot-id URL); the client's own token is never sent here.
         */
        publish: async (url, offer, { key, signal } = {}) => {
            const target = await url;
            const res = await client.request({
                // The answer is application/sdp (read as text); an error is Live's JSON, so its code reaches OpenVibeError.
                url: target, method: 'POST', body: String(offer), auth: false, idempotencyKey: false, retries: 0, signal,
                headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            });
            const loc = res.headers.get('location');
            return { answer: res.data, location: loc ? new URL(loc, target).href : null };
        },
        /** End a WHIP session (its Location). The last session on a stream ends the stream. */
        end: async (location, { signal } = {}) => {
            await client.request({ url: String(location), method: 'DELETE', auth: false, idempotencyKey: false, signal });
        },
    };

    return { streams, slots, goLive, channels, content, whip };
}

module.exports = { createLiveClient };
