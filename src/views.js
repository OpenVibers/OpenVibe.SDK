'use strict';

/**
 * openvibe-sdk/views — one view API for every content kind.
 *
 *   const views = createViewsClient(client);
 *   await views.record({ ref: { service: 'media', kind: 'vod', id: '42' }, how: 'preview', seconds: 2, session });
 *   await views.record([ … up to 20 events … ]);
 *   const counts = await views.counts({ service: 'media', kind: 'vod', id: '42' });
 *   // → { ref, counts: { views, engaged, previews, preview_share, peak_concurrent } }
 *
 * OpenVibe.Media owns the numbers for every kind (a Media VOD or clip, a Live recording or stream, a Feed item):
 * POST /api/v1/views is public and CORS *, dedupes one view per person or anonymous session per item per 30 minutes,
 * counts a preview from 1 second and engagement at 30 seconds or a third of the length (60 seconds of a live stream),
 * and never stores an IP address or a user agent. `seconds` is cumulative for the session and item: a retry sends the
 * same number, playback sends a larger one, and neither counts the item twice.
 *
 * A signed-in viewer sends their Network token on the client and no session; a signed-out viewer keeps an opaque
 * `session` id of their own. The write is not retried for you: a retry is safe (same session, same item), but this
 * client leaves the decision to the caller, like the other beacon-shaped writes.
 */
const MEDIA_URL = 'https://openvibe.media';
const MAX_BATCH = 20;
const HOWS = ['preview', 'watch', 'live'];
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SESSION_RE = /^[A-Za-z0-9._~-]{8,128}$/;

function refOf(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new TypeError('views: ref must be { service, kind, id }');
    const service = String(ref.service || '');
    const kind = String(ref.kind || '');
    const id = ref.id == null ? '' : String(ref.id);
    if (!SERVICE_RE.test(service)) throw new TypeError('views: ref.service is a service id (media, live, network…)');
    if (!KIND_RE.test(kind)) throw new TypeError('views: ref.kind is an item type (vod, clip, recording, stream…)');
    if (!id || id.length > 200) throw new TypeError('views: ref.id is 1–200 characters');
    const out = { service, kind, id };
    if (ref.site != null) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(ref.site))) throw new TypeError('views: ref.site is a site id');
        out.site = String(ref.site);
    }
    if (ref.creator != null) {
        if (String(ref.creator).length > 200) throw new TypeError('views: ref.creator is at most 200 characters');
        out.creator = String(ref.creator);
    }
    return out;
}

function eventOf(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('views.record: each event is an object');
    const how = String(event.how || '');
    if (!HOWS.includes(how)) throw new TypeError(`views.record: how is ${HOWS.join(', ')}`);
    const seconds = Number(event.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new TypeError('views.record: seconds is 0–86400');
    const out = { ref: refOf(event.ref), how, seconds };
    if (event.of_seconds != null) {
        const of = Number(event.of_seconds);
        if (!Number.isFinite(of) || of <= 0 || of > 86400) throw new TypeError('views.record: of_seconds is 1–86400');
        out.of_seconds = of;
    }
    if (event.session != null) {
        if (!SESSION_RE.test(String(event.session))) throw new TypeError('views.record: session is 8–128 letters, digits, . _ ~ or -');
        out.session = String(event.session);
    }
    return out;
}

function createViewsClient(client, { baseUrl = MEDIA_URL } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createViewsClient: pass an openvibe-sdk/core client');
    const base = String(baseUrl || MEDIA_URL).replace(/\/+$/, '');
    return {
        /**
         * Record one event or up to 20 at once. → { results: [{ accepted, counted, engaged, reason? }], counts? }
         * `session` is required by the service for a signed-out viewer; a signed-in viewer sends their token instead.
         */
        record(events, { signal } = {}) {
            const list = Array.isArray(events) ? events : [events];
            if (!list.length) throw new TypeError('views.record: send at least one event');
            if (list.length > MAX_BATCH) throw new TypeError(`views.record: at most ${MAX_BATCH} events in one call`);
            return client.json({
                baseUrl: base, path: '/api/v1/views', method: 'POST',
                json: { events: list.map(eventOf) }, signal, service: 'media',
            });
        },
        /** One item's numbers: views, engaged viewers, preview views, the feed-preview share and live peak concurrent. */
        counts(ref, { signal } = {}) {
            const r = refOf(ref);
            return client.json({
                baseUrl: base, path: '/api/v1/views/counts',
                query: { service: r.service, kind: r.kind, id: r.id }, signal, service: 'media',
            });
        },
    };
}

module.exports = { createViewsClient, refOf, eventOf, MEDIA_URL, MAX_BATCH, HOWS };
