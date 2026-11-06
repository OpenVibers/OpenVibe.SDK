'use strict';
/**
 * openvibe-sdk/streams — the Agent Streams plan (S1): an agent's own stream on OpenVibe.Live.
 *
 * An agent stream is a Live stream of kind 'agent' (id ags_…): it has no stream key and takes no slot, and it is
 * published with a ticket (wpt_…) instead of one. The desk (OpenVibe.Node) or a person's browser (a Codes task page)
 * creates it, keeps the ticket and publishes through it; the owner watches the stream on the page Live answers with.
 *
 *   const streams = createStreamsClient(createClient({ tokenProvider }));
 *   const { stream, publish } = await streams.startAgentStream({
 *       title: 'Fixing the login page',
 *       task: { source: 'codes', ref: 'task_…', title: 'Fix the login page' },
 *       visibility: 'private',
 *   });
 *   await streams.postFrame(stream.id, jpegBytes, { ticket: publish.ticket });   // a snapshot while Live wants no video
 *   const s = await streams.state(stream.id, { ticket: publish.ticket });         // { viewers, encode, curtain, ends_at }
 *   await streams.setCurtain(stream.id, true, 'password_field');                 // the desk's privacy screen
 *   await streams.renewTicket(stream.id);                                       // the ticket lives four hours
 *   await streams.end(stream.id);
 *
 * The publish ticket is a bearer of its own: on the desk's routes (the state poll and the frame upload) the desk sends
 * the ticket instead of the person's token, so Live never sees the person's token there. The ticket is shown once and
 * Live keeps only its hash.
 */
const AGENT_STREAM_ID = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;
const VISIBILITIES = ['private', 'unlisted', 'public'];
const TASK_SOURCES = ['codes', 'actor', 'desk', 'node'];
const CURTAIN_REASONS = ['password_field', 'secret_file', 'env_print', 'manual', 'site', 'detector'];
const FRAME_TYPES = ['image/jpeg', 'image/webp'];
const MAX_FRAME_BYTES = 200 * 1024;

/** The frame's bytes, whatever the caller has: a Uint8Array, a Buffer or an ArrayBuffer. */
function frameBytes(v) {
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    throw new TypeError('streams: a frame is bytes (a Uint8Array or an ArrayBuffer)');
}

/**
 * createStreamsClient(client, { baseUrl }) — the agent-stream routes of OpenVibe.Live.
 * The client is an openvibe-sdk/core client; its token is the person's (or the service's) token.
 */
function createStreamsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') throw new TypeError('createStreamsClient: pass an openvibe-sdk/core client');
    const at = { service: 'live', baseUrl, audience: 'openvibe.live' };
    // A write is never retried on its own: Live keys no agent-stream route by Idempotency-Key, and a second start is
    // a second stream.
    const call = ({ method = 'GET', ...opts }) => client.json({ ...at, method, ...(method === 'GET' ? {} : { idempotencyKey: false }), ...opts });
    const streamId = (v) => {
        const id = String(v || '');
        if (!AGENT_STREAM_ID.test(id)) throw new TypeError('streams: an agent stream id is ags_…');
        return id;
    };
    const text = (v, max, what) => {
        if (typeof v !== 'string' || !v.trim() || v.length > max) throw new TypeError(`streams: ${what} is 1–${max} characters`);
        return v.trim();
    };
    const oneOf = (v, allowed, what) => {
        if (!allowed.includes(v)) throw new TypeError(`streams: ${what} is ${allowed.join(', ')}`);
        return v;
    };
    const uri = (v, what) => {
        if (typeof v !== 'string' || !v.trim()) throw new TypeError(`streams: ${what} is a URI`);
        try { new URL(v); } catch { throw new TypeError(`streams: ${what} is a URI`); }
        return v;
    };

    return {
        /**
         * Start an agent's stream → { stream, publish }: the stream (live.agent-stream@1) and the publish part
         * (live.agent-stream-publish@1) with the WHIP url, the publish ticket and the moment it dies. The ticket is
         * shown once; keep it, and renew it before it expires (it lives four hours).
         *
         * @param {{ title: string, task: { source: 'codes'|'actor'|'desk'|'node', ref: string, title: string, url?: string },
         *           visibility: 'private'|'unlisted'|'public', allowSites?: string[] }} request
         * @param {{ signal?: AbortSignal }} [options]
         * @returns {Promise<{ stream: object, publish: { whip_url: string, ticket: string, expires_at: string } }>}
         */
        async startAgentStream(request = {}, { signal } = {}) {
            const r = request || {};
            const task = r.task || {};
            const body = {
                title: text(r.title, 200, 'a title'),
                task: {
                    source: oneOf(task.source, TASK_SOURCES, 'the task source'),
                    ref: text(task.ref, 200, 'a task reference'),
                    title: text(task.title, 200, 'a task title'),
                    ...(task.url ? { url: uri(task.url, 'the task URL') } : {}),
                },
                visibility: oneOf(r.visibility, VISIBILITIES, 'the visibility'),
                ...(r.allowSites === undefined ? {} : {
                    allow_sites: (() => {
                        if (!Array.isArray(r.allowSites) || r.allowSites.length > 50) throw new TypeError('streams: allowSites is an array of at most 50 URIs');
                        return r.allowSites.map((site) => uri(site, 'an allowed site'));
                    })(),
                }),
            };
            return call({ method: 'POST', path: '/api/streams/agent', json: body, signal });
        },

        /**
         * A new publish ticket for a stream that is still live → the publish part again (the desk renews at three hours).
         * The old ticket stops working at once.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ signal?: AbortSignal }} [options]
         */
        async renewTicket(id, { signal } = {}) {
            return call({ method: 'POST', path: `/api/streams/agent/${streamId(id)}/ticket`, signal });
        },

        /**
         * Revoke the publish ticket: the kill switch. Live ends the WHIP session at once.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ signal?: AbortSignal }} [options]
         */
        async revokeTicket(id, { signal } = {}) {
            return call({ method: 'DELETE', path: `/api/streams/agent/${streamId(id)}/ticket`, signal });
        },

        /**
         * What the desk polls every ten seconds → { viewers, encode, curtain, ends_at }. While encode is false the
         * desk stops encoding and sends a snapshot every five seconds (postFrame).
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ ticket?: string, signal?: AbortSignal }} [options] the publish ticket, when the desk has one
         */
        async state(id, { ticket, signal } = {}) {
            return call({ method: 'GET', path: `/api/streams/agent/${streamId(id)}/state`, ...(ticket ? { token: ticket } : {}), signal });
        },

        /**
         * Raise or drop the desk's privacy screen. While it is up Live pauses every viewer's consumer, so a desk that
         * failed to blank still shows nothing; viewers see "Private screen" and never why.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {boolean} up true to raise it
         * @param {'password_field'|'secret_file'|'env_print'|'manual'|'site'|'detector'} reason why
         * @param {{ signal?: AbortSignal }} [options]
         */
        async setCurtain(id, up, reason, { signal } = {}) {
            const body = { up: Boolean(up), reason: oneOf(reason, CURTAIN_REASONS, 'the curtain reason') };
            return call({ method: 'POST', path: `/api/streams/agent/${streamId(id)}/curtain`, json: body, signal });
        },

        /**
         * Send the last frame (JPEG or WebP, at most 200 KB): the card's picture and the task page's. The desk sends it
         * while Live wants no video.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {Uint8Array|ArrayBuffer} bytes the frame
         * @param {{ ticket?: string, contentType?: 'image/jpeg'|'image/webp', signal?: AbortSignal }} [options]
         */
        async postFrame(id, bytes, { ticket, contentType = 'image/jpeg', signal } = {}) {
            const body = frameBytes(bytes);
            if (!body.byteLength) throw new TypeError('streams: a frame is not empty');
            if (body.byteLength > MAX_FRAME_BYTES) throw new TypeError('streams: a frame is at most 200 KB');
            const res = await client.request({
                ...at, method: 'PUT', path: `/api/streams/agent/${streamId(id)}/frame`, body,
                headers: { 'Content-Type': oneOf(contentType, FRAME_TYPES, 'the frame type') },
                ...(ticket ? { token: ticket } : {}), idempotencyKey: false, signal,
            });
            return res.data;
        },

        /**
         * Switch who may watch (the owner's switch): private, unlisted or public.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {'private'|'unlisted'|'public'} visibility
         * @param {{ signal?: AbortSignal }} [options]
         */
        async setVisibility(id, visibility, { signal } = {}) {
            const body = { visibility: oneOf(visibility, VISIBILITIES, 'the visibility') };
            return call({ method: 'PUT', path: `/api/streams/agent/${streamId(id)}/visibility`, json: body, signal });
        },

        /**
         * End the stream. The card stays, with the last frame, the worked seconds and the VOD once it is recorded.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ signal?: AbortSignal }} [options]
         */
        async end(id, { signal } = {}) {
            return call({ method: 'POST', path: `/api/streams/agent/${streamId(id)}/end`, signal });
        },

        /**
         * A view ticket (wvt_…, ten minutes) for the player's join message. The owner's own session gets one, and so
         * does anyone the sharing system lets see a private stream.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ signal?: AbortSignal }} [options]
         */
        async viewTicket(id, { signal } = {}) {
            return call({ method: 'POST', path: `/api/streams/agent/${streamId(id)}/view-ticket`, signal });
        },
    };
}

module.exports = { createStreamsClient };
