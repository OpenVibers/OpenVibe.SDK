'use strict';
/**
 * openvibe-sdk/openre — OpenRe.Stream, the platform's streaming engine (ingest, sessions, restream outputs), for
 * every product that puts a stream on air (OpenVibe.Live first). One client instead of a copy in each product.
 * Server-side: it sends a Network service token for audience openvibe.openre.
 *
 *   const tokens = createServiceTokenClient({ tokenUrl, clientId, clientSecret });
 *   const openre = createOpenReClient(createClient({ tokenProvider: tokens, baseUrls: { openre: 'http://127.0.0.1:4500' } }));
 *   const s = await openre.streams.byExternalRef('live:managed_stream:12');          // or null
 *   const { stream } = await openre.streams.create({ title, external_refs }, { subject: 'usr_…' });
 *   const { key } = await openre.streams.rotateKey(s.id, { subject, graceSeconds: 0 });
 *   const pb = await openre.sessions.playback(sessionId);                              // cached 10 s
 *
 * Grants (on the caller's principal, audience openvibe.openre): openre.stream.read / .write, openre.key.rotate,
 * openre.output.read / .write, openre.session.read / .end. `subject` names the person a call acts for
 * (X-OV-Subject; a usr_ id); OpenRe checks that they own the stream. Errors are OpenVibeError (status, code);
 * a missing stream, destination or session is null from get(), not an error.
 * Shapes: Contracts openre.stream@1, openre.destination@1, openre.output@1, openre.session-read-result@1.
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const PLAYBACK_TTL_MS = 10_000;

function createOpenReClient(client, { baseUrl, publicUrl = 'https://openre.stream', playbackTtlMs = PLAYBACK_TTL_MS, now = () => Date.now() } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createOpenReClient: pass an openvibe-sdk/core client');
    const call = ({ subject, ...opts }) => client.json({
        service: 'openre', baseUrl, audience: 'openvibe.openre', ...opts,
        headers: { ...(opts.headers || {}), ...(subject ? { 'X-OV-Subject': String(subject) } : {}) },
    });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const pick = (key) => (r) => (r ? r[key] : null);
    const playbackCache = new Map();

    const streams = {
        /** { streams, next_cursor? } — filter by external_ref ("<service>:<type>:<id>"). */
        list: ({ externalRef, limit, cursor, subject } = {}) => call({ path: '/api/v1/streams', query: { external_ref: externalRef, limit, cursor }, subject }),
        /** The stream a product object points at, or null. */
        byExternalRef: async (externalRef, opts = {}) => ((await streams.list({ ...opts, externalRef })).streams || [])[0] || null,
        /** → { stream, key? }. The key in a create answer is shown once. */
        create: (body, { subject, idempotencyKey } = {}) => call({ method: 'POST', path: '/api/v1/streams', json: body, subject, idempotencyKey }),
        get: (id, { subject } = {}) => orNull(call({ path: `/api/v1/streams/${enc(id)}`, subject })).then(pick('stream')),
        update: (id, patch, { subject } = {}) => call({ method: 'PATCH', path: `/api/v1/streams/${enc(id)}`, json: patch, subject }).then(pick('stream')),
        delete: (id, { subject } = {}) => call({ method: 'DELETE', path: `/api/v1/streams/${enc(id)}`, subject }),
        /** Key metadata (never the secret). */
        keys: (id, { subject } = {}) => call({ path: `/api/v1/streams/${enc(id)}/keys`, subject }),
        /** → openre.key-rotate-result@1 ({ key, ingest, … }); the old key keeps working for graceSeconds. */
        rotateKey: (id, { subject, graceSeconds = 0 } = {}) => call({ method: 'POST', path: `/api/v1/streams/${enc(id)}/keys/rotate`, json: { grace_seconds: graceSeconds }, subject }),
        destinations: (id, { subject } = {}) => call({ path: `/api/v1/streams/${enc(id)}/destinations`, subject }).then(pick('destinations')),
        addDestination: (id, body, { subject } = {}) => call({ method: 'POST', path: `/api/v1/streams/${enc(id)}/destinations`, json: body, subject }).then(pick('destination')),
    };

    const destinations = {
        update: (id, patch, { subject } = {}) => call({ method: 'PATCH', path: `/api/v1/destinations/${enc(id)}`, json: patch, subject }).then(pick('destination')),
        delete: (id, { subject } = {}) => call({ method: 'DELETE', path: `/api/v1/destinations/${enc(id)}`, subject }),
        /** A short test push to the destination; → { ok, detail }. */
        test: (id, { subject } = {}) => call({ method: 'POST', path: `/api/v1/destinations/${enc(id)}/test`, subject, timeoutMs: 30_000 }),
        start: (id, { subject } = {}) => call({ method: 'POST', path: `/api/v1/destinations/${enc(id)}/start`, subject }),
        stop: (id, { subject } = {}) => call({ method: 'POST', path: `/api/v1/destinations/${enc(id)}/stop`, subject }),
        logs: (id, { subject, limit } = {}) => call({ path: `/api/v1/destinations/${enc(id)}/logs`, query: { limit }, subject }),
    };

    const sessions = {
        list: ({ streamId, state, limit, cursor, subject } = {}) => call({ path: '/api/v1/sessions', query: { stream_id: streamId, state, limit, cursor }, subject }),
        get: (id, { subject } = {}) => orNull(call({ path: `/api/v1/sessions/${enc(id)}`, subject })).then(pick('session')),
        /** The playback descriptor (cached playbackTtlMs: players ask on every viewer connect). */
        async playback(id) {
            const hit = playbackCache.get(id);
            if (hit && now() - hit.at < playbackTtlMs) return hit.value;
            const value = await orNull(call({ path: `/api/v1/sessions/${enc(id)}/playback` })).then(pick('playback'));
            playbackCache.set(id, { at: now(), value });
            if (playbackCache.size > 500) for (const [k, v] of playbackCache) if (now() - v.at > 6 * playbackTtlMs) playbackCache.delete(k);
            return value;
        },
        end: (id, { subject, reason } = {}) => call({ method: 'POST', path: `/api/v1/sessions/${enc(id)}/end`, json: reason ? { reason } : {}, subject }),
        outputs: (id, { subject } = {}) => call({ path: `/api/v1/sessions/${enc(id)}/outputs`, subject }).then(pick('outputs')),
    };

    return {
        streams,
        destinations,
        sessions,
        outputLogs: (id, { subject, limit } = {}) => call({ path: `/api/v1/outputs/${enc(id)}/logs`, query: { limit }, subject }),
        workers: () => call({ path: '/api/v1/workers' }),
        /** The standalone UI's page for a stream (for "manage on OpenRe.Stream" links). */
        manageUrl: (streamId) => `${String(publicUrl).replace(/\/+$/, '')}/streams/${enc(streamId || '')}`,
        clearCache: () => playbackCache.clear(),
    };
}

module.exports = { createOpenReClient };
