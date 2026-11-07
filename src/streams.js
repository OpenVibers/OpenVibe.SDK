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
const MODES = ['watch', 'narrated', 'copilot', 'chatplays'];
const STEP_STATUSES = ['started', 'passed', 'failed', 'skipped'];
const SCHEDULE_ID = /^scd_[0-9A-HJKMNP-TV-Z]{26}$/;
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

    const scheduleId = (v) => {
        const id = String(v || '');
        if (!SCHEDULE_ID.test(id)) throw new TypeError('streams: a schedule id is scd_…');
        return id;
    };
    const cleanStep = (step = {}) => {
        const r = step || {};
        const body = {
            title: text(r.title, 120, 'a step title'),
            status: oneOf(r.status, STEP_STATUSES, 'the step status'),
        };
        if (r.at) body.at = new Date(r.at).toISOString();
        if (r.detail !== undefined) body.detail = text(r.detail, 500, 'the step detail');
        if (r.tests !== undefined) {
            if (!r.tests || !Number.isInteger(r.tests.passed) || !Number.isInteger(r.tests.failed) || r.tests.passed < 0 || r.tests.failed < 0) {
                throw new TypeError('streams: tests is { passed, failed }, whole numbers');
            }
            body.tests = { passed: r.tests.passed, failed: r.tests.failed };
        }
        if (r.cost_usd !== undefined) {
            const n = Number(r.cost_usd);
            if (!Number.isFinite(n) || n < 0) throw new TypeError('streams: cost_usd is a number, zero or more');
            body.cost_usd = n;
        }
        return body;
    };
    const chatCall = ({ method = 'GET', ...opts }) => client.json({
        service: 'chat', audience: 'openvibe.chat', method,
        ...(method === 'GET' ? {} : { idempotencyKey: false }), ...opts,
    });

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
         * Schedule a public agent stream (live.agent-stream-schedule@1): a time, a task template and the mode. The
         * owner's online desk claims it at the time, which starts the stream; a desk that is offline leaves
         * "didn't start: the desk was offline" and nothing runs. A chatplays schedule always waits for Go.
         *
         * @param {{ title: string, task: object, mode?: 'watch'|'narrated'|'copilot'|'chatplays',
         *           visibility?: 'private'|'unlisted'|'public', startsAt: string|Date }} request
         * @param {{ signal?: AbortSignal }} [options]
         */
        async schedule(request = {}, { signal } = {}) {
            const r = request || {};
            const starts = r.startsAt instanceof Date ? r.startsAt : new Date(String(r.startsAt || ''));
            if (Number.isNaN(starts.getTime())) throw new TypeError('streams: startsAt is a date-time');
            return call({
                method: 'POST', path: '/api/streams/agent/schedules',
                json: {
                    title: text(r.title, 200, 'a title'),
                    task: r.task,
                    mode: oneOf(r.mode || 'watch', MODES, 'the mode'),
                    visibility: oneOf(r.visibility || 'public', VISIBILITIES, 'the visibility'),
                    starts_at: starts.toISOString(),
                }, signal,
            });
        },

        /** The caller's own schedules (`mine: true`) or a channel's public 24-hour window. */
        async listSchedules({ channel = null, mine = false } = {}, { signal } = {}) {
            const q = mine ? '?mine=1' : `?channel=${encodeURIComponent(String(channel || ''))}`;
            if (!mine && !channel) throw new TypeError('streams: listSchedules needs a channel or mine: true');
            return call({ method: 'GET', path: `/api/streams/agent/schedules${q}`, signal });
        },

        /** Cancel a schedule that has not started. */
        async cancelSchedule(id, { signal } = {}) {
            return call({ method: 'DELETE', path: `/api/streams/agent/schedules/${scheduleId(id)}`, signal });
        },

        /** Opt in to a schedule's reminder. The answer is the count, never the people. */
        async remindSchedule(id, { signal } = {}) {
            return call({ method: 'POST', path: `/api/streams/agent/schedules/${scheduleId(id)}/remind`, signal });
        },

        /**
         * Post one step (live.agent-stream-step@1) from any agent harness: the overlay and the VOD's chapters read it.
         * With a publish ticket the desk posts it; a first-party service token holding live.agent_stream.publish may
         * post for its owner.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ title: string, status: 'started'|'passed'|'failed'|'skipped', detail?: string,
         *           tests?: { passed: number, failed: number }, cost_usd?: number, at?: string|Date }} step
         * @param {{ ticket?: string, signal?: AbortSignal }} [options]
         */
        async postStep(id, step, { ticket, signal } = {}) {
            return call({
                method: 'POST', path: `/api/streams/agent/${streamId(id)}/steps`, json: cleanStep(step),
                ...(ticket ? { token: ticket } : {}), signal,
            });
        },

        /** steps.post() — the design's spelling of postStep. */
        steps: {
            async post(id, step, { ticket, signal } = {}) {
                return call({
                    method: 'POST', path: `/api/streams/agent/${streamId(id)}/steps`, json: cleanStep(step),
                    ...(ticket ? { token: ticket } : {}), signal,
                });
            },
        },

        /**
         * The Co-pilot digest (S5): what the room said between two steps. Behind the token's chat.agent_digest.read
         * capability; a person's token never holds it, so this is a service token's call.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ since?: string, signal?: AbortSignal }} [options]
         */
        digest: {
            async read(id, { since, signal } = {}) {
                const q = since ? `?since=${encodeURIComponent(since)}` : '';
                return chatCall({ method: 'GET', path: `/api/v1/rooms/agent:${streamId(id)}/digest${q}`, signal });
            },
        },

        /**
         * A poll the Co-pilot asks the room to run (S5), and its result. Behind chat.agent_poll.write.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {{ question: string, options: string[], seconds?: number }} poll
         * @param {{ signal?: AbortSignal }} [options]
         */
        poll: {
            async open(id, { question, options, seconds = 60 } = {}, { signal } = {}) {
                if (typeof question !== 'string' || !question.trim()) throw new TypeError('streams: a poll question is required');
                if (!Array.isArray(options) || options.length < 2 || options.length > 4) throw new TypeError('streams: a poll has two to four options');
                const n = Number(seconds);
                if (!Number.isInteger(n) || n < 10 || n > 300) throw new TypeError('streams: a poll lasts 10–300 seconds');
                return chatCall({
                    method: 'POST', path: `/api/v1/rooms/agent:${streamId(id)}/poll`,
                    json: { question: question.trim(), options: options.map((o) => String(o)), seconds: n }, signal,
                });
            },
            async result(id, { signal } = {}) {
                return chatCall({ method: 'GET', path: `/api/v1/rooms/agent:${streamId(id)}/poll`, signal });
            },
        },

        /**
         * Honour pause, curtain, mute and end: poll the stream's control log and call `handler(control)` for each new
         * one. Returns a stop function; `signal` stops it too. The first poll only marks what is already there, so a
         * harness that starts late does not replay yesterday's End.
         *
         * @param {string} id the agent stream id (ags_…)
         * @param {(control: object) => void} handler
         * @param {{ intervalMs?: number, signal?: AbortSignal }} [options]
         */
        onControl(id, handler, { intervalMs = 5000, signal } = {}) {
            const stream = streamId(id);
            if (typeof handler !== 'function') throw new TypeError('streams: onControl needs a handler');
            let stopped = false;
            let timer = null;
            let seen = null;
            const key = (c) => `${c.at}|${c.control}|${(c.by && c.by.handle) || ''}`;
            const tick = async () => {
                if (stopped) return;
                try {
                    const out = await call({ method: 'GET', path: `/api/streams/agent/${stream}/controls`, signal });
                    const list = (out && out.controls) || [];
                    if (seen === null) { seen = new Set(list.map(key)); }
                    else {
                        for (const c of [...list].reverse()) {
                            if (seen.has(key(c))) continue;
                            seen.add(key(c));
                            try { handler(c); } catch { /* the harness's own error */ }
                        }
                    }
                } catch { /* a poll failure is retried next time */ }
                if (!stopped) { timer = setTimeout(tick, Math.max(1000, Number(intervalMs) || 5000)); if (timer.unref) timer.unref(); }
            };
            tick();
            if (signal) signal.addEventListener('abort', () => { stopped = true; if (timer) clearTimeout(timer); }, { once: true });
            return () => { stopped = true; if (timer) clearTimeout(timer); };
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
