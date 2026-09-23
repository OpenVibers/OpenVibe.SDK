'use strict';
/**
 * openvibe-sdk/events (server): OpenVibe.Events, the durable event backbone.
 * Service token with audience openvibe.events; each route checks one capability:
 *   events.event.publish        publish()
 *   events.event.read           pull(), iterate(), get(), checkpoints
 *   events.subscription.manage  subscriptions.*
 *   events.delivery.admin       deliveries(), replay()
 *
 * Developer apps (Network ADR-014) use the same routes with an app token and the capabilities
 * events.app.publish | events.app.read | events.app.subscribe; createAppEvents() fills in what
 * Events requires of them (see below).
 *
 * Browsers use openvibe-sdk/realtime (SSE) instead.
 */
const crypto = require('node:crypto');
const { isOpenVibeError } = require('./core/errors');
const { newEventId } = require('./core/ids');
const { startSpan } = require('./core/trace');

// ── Webhook signatures ───────────────────────────────────────

/** `sha256=<hex HMAC-SHA256 of the raw body>`, the value of X-OpenVibe-Signature. */
function signDelivery(rawBody, secret) {
    return `sha256=${crypto.createHmac('sha256', String(secret)).update(toBuffer(rawBody)).digest('hex')}`;
}

/** Constant-time check of a delivery's X-OpenVibe-Signature against the RAW request body. */
function verifyDelivery(rawBody, signatureHeader, secret) {
    if (rawBody == null || typeof signatureHeader !== 'string' || !secret) return false;
    const expected = Buffer.from(signDelivery(rawBody, secret));
    const given = Buffer.from(signatureHeader.trim());
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// v2 (replay window). Events also sends, on every attempt with the time it is sent:
//   X-OpenVibe-Timestamp:    <unix seconds>
//   X-OpenVibe-Signature-V2: t=<unix seconds>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">
// A v1 signature covers only the body, so a captured delivery verifies forever; v2 stops
// verifying once the timestamp is more than `toleranceSec` (300) from the consumer's clock.

const V2_TOLERANCE_SEC = 300;

function v2Hex(rawBody, secret, timestamp) {
    return crypto.createHmac('sha256', String(secret)).update(`${timestamp}.`).update(toBuffer(rawBody)).digest('hex');
}

/** `t=<ts>,v2=<hex HMAC-SHA256 of "<ts>.<raw body>">`, the value of X-OpenVibe-Signature-V2. */
function signDeliveryV2(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('timestamp must be unix seconds');
    return `t=${timestamp},v2=${v2Hex(rawBody, secret, timestamp)}`;
}

/**
 * The three signature headers Events puts on a delivery (X-OpenVibe-Signature,
 * X-OpenVibe-Timestamp, X-OpenVibe-Signature-V2), for tests that post deliveries to a consumer.
 */
function signDeliveryHeaders(rawBody, secret, { now = Date.now() } = {}) {
    const timestamp = Math.floor(Number(now) / 1000);
    return {
        'X-OpenVibe-Signature': signDelivery(rawBody, secret),
        'X-OpenVibe-Timestamp': String(timestamp),
        'X-OpenVibe-Signature-V2': signDeliveryV2(rawBody, secret, timestamp),
    };
}

/** One header from req.headers (any key case; arrays joined) or a Fetch Headers; undefined if absent. */
function headerValue(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
    let v = headers[name];
    if (v === undefined) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
        v = key === undefined ? undefined : headers[key];
    }
    return Array.isArray(v) ? v.join(',') : v;
}

/**
 * Constant-time check of a delivery's X-OpenVibe-Signature-V2 against the RAW request body, and
 * of its timestamp: false when it is more than `toleranceSec` from `now` (ms) either way, or when
 * X-OpenVibe-Timestamp is present and names another time. `headers` is req.headers (or a Fetch Headers).
 */
function verifyDeliveryV2(rawBody, headers, secret, { toleranceSec = V2_TOLERANCE_SEC, now = Date.now() } = {}) {
    if (!Number.isFinite(toleranceSec) || toleranceSec < 0) throw new TypeError('toleranceSec must be a number of seconds >= 0');
    const header = headerValue(headers, 'x-openvibe-signature-v2');
    if (rawBody == null || typeof header !== 'string' || !secret) return false;
    let t = null;
    const given = [];
    for (const part of header.split(',')) {
        const i = part.indexOf('=');
        if (i < 0) return false;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') {
            if (t !== null || !/^\d{1,12}$/.test(v)) return false;
            t = Number(v);
        } else if (k === 'v2') given.push(v);
    }
    if (t === null || !given.length) return false;
    const stated = headerValue(headers, 'x-openvibe-timestamp');
    if (stated !== undefined && String(stated).trim() !== String(t)) return false;
    if (Math.abs(Number(now) / 1000 - t) > toleranceSec) return false;
    const expected = Buffer.from(v2Hex(rawBody, secret, t));
    let ok = false;
    for (const v of given) {
        const g = Buffer.from(v);
        if (g.length === expected.length && crypto.timingSafeEqual(g, expected)) ok = true;
    }
    return ok;
}

/**
 * Verify and parse one delivery: { event, seq, subscriptionId, attempt } or null when it does not
 * verify. `headers` is req.headers (or a Fetch Headers).
 *
 *   X-OpenVibe-Signature-V2 present  it must verify and be within ±toleranceSec (default 300) of
 *                                    `now`; a bad or stale v2 is null, never a fallback to v1
 *   no v2 header                     v1 (X-OpenVibe-Signature) is accepted unless requireV2
 *
 * Set requireV2: true once OpenVibe.Events sends v2 to you: then a replayed v1-only delivery fails.
 */
function parseDelivery(rawBody, headers, secret, { requireV2 = false, toleranceSec, now } = {}) {
    const get = (k) => headerValue(headers, k);
    if (get('x-openvibe-signature-v2') !== undefined) {
        if (!verifyDeliveryV2(rawBody, headers, secret, { toleranceSec, now })) return null;
    } else if (requireV2 || !verifyDelivery(rawBody, get('x-openvibe-signature'), secret)) {
        return null;
    }
    let body;
    try { body = JSON.parse(toBuffer(rawBody).toString('utf8')); } catch { return null; }
    if (!body || !body.event) return null;
    return {
        event: body.event,
        seq: Number(body.seq ?? get('x-openvibe-seq')),
        subscriptionId: get('x-openvibe-subscription-id') || null,
        attempt: Number(get('x-openvibe-delivery-attempt')) || 1,
    };
}

function toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    return Buffer.from(String(raw));
}

// ── Client ───────────────────────────────────────────────────

function createEventsClient(client, { source, baseUrl } = {}) {
    const call = (opts) => client.json({ service: 'events', baseUrl, audience: 'openvibe.events', ...opts });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });

    /**
     * Fill what a producer should not have to think about: event_id (evt_<ULID>), timestamp,
     * source (from the client config), version 1, payload {}, trace_id (from the call's trace).
     */
    function prepare(envelope, { traceId, now = Date.now() } = {}) {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('an event envelope must be an object');
        const out = { ...envelope };
        if (!out.event_id) out.event_id = newEventId(now);
        if (!out.timestamp) out.timestamp = new Date(now).toISOString();
        if (!out.source) out.source = source;
        if (!out.source) throw new TypeError('envelope.source is required (or pass { source } to createEventsClient)');
        if (out.version == null) out.version = 1;
        if (out.payload == null) out.payload = {};
        if (!out.trace_id && traceId) out.trace_id = traceId;
        return out;
    }

    /**
     * publish(envelope | envelope[], { traceparent }) -> { event_id, seq, duplicate } | { results }.
     * Safe to retry: Events stores an event_id once and answers a repeat with the stored seq.
     */
    async function publish(input, { traceparent } = {}) {
        const span = startSpan(traceparent || client.traceparent());
        const many = Array.isArray(input);
        const events = (many ? input : [input]).map((e) => prepare(e, { traceId: span.traceId }));
        return call({
            method: 'POST', path: '/api/v1/events', json: many ? { events } : events[0], traceparent: span.traceparent,
            idempotent: true, idempotencyKey: many ? undefined : events[0].event_id,
        });
    }

    /** One page: { events: [{ seq, event }], next_after_seq, latest_seq, gap? } */
    function pull({ topic = '*', afterSeq = 0, limit } = {}) {
        return call({ path: '/api/v1/events', query: { topic: Array.isArray(topic) ? topic.join(',') : topic, after_seq: afterSeq, limit } });
    }

    /**
     * Async iterator over { seq, event } from afterSeq up to the current head.
     *
     *   onGap(gap)   called before a page's items when retention already pruned part of the range
     *                ({ from_seq, to_seq }): nothing can replay it, so resync derived state.
     *   onPage(page) called AFTER every item of that page was yielded and handled (your loop body
     *                ran for the page's last item and asked for the next one). Save
     *                page.next_after_seq there as your durable cursor: it also moves past events
     *                that did not match your topics, and a crash (or a break/throw in your loop)
     *                before onPage leaves the cursor on the last page you finished, so nothing is
     *                skipped. Pages with no matching events still call onPage.
     */
    async function* iterate({ topic, afterSeq = 0, limit, onGap, onPage, maxPages = Infinity } = {}) {
        let cursor = afterSeq;
        for (let pages = 0; pages < maxPages; pages++) {
            const page = await pull({ topic, afterSeq: cursor, limit });
            if (page.gap && onGap) await onGap(page.gap);
            for (const item of page.events || []) yield item;
            if (onPage) await onPage(page);
            const next = page.next_after_seq;
            if (next == null || next === cursor || !(next < page.latest_seq)) return;
            cursor = next;
        }
    }

    const subscriptions = {
        /** { topicPattern, endpoint, secret?, retryPolicy? } -> subscription incl. `secret` (shown once). */
        create: ({ topicPattern, endpoint, secret, retryPolicy } = {}) => call({
            method: 'POST', path: '/api/v1/subscriptions', idempotencyKey: false,
            json: { topic_pattern: topicPattern, endpoint, secret, retry_policy: retryPolicy },
        }),
        async list() { return (await call({ path: '/api/v1/subscriptions' })).subscriptions; },
        get: (id) => orNull(call({ path: `/api/v1/subscriptions/${encodeURIComponent(id)}` })),
        disable: (id) => call({ method: 'POST', path: `/api/v1/subscriptions/${encodeURIComponent(id)}/disable`, idempotent: true }),
        enable: (id) => call({ method: 'POST', path: `/api/v1/subscriptions/${encodeURIComponent(id)}/enable`, idempotent: true }),
    };

    return {
        prepare,
        publish,
        pull,
        iterate,
        /** { seq, event } or null. */
        get: (eventId) => orNull(call({ path: `/api/v1/events/${encodeURIComponent(eventId)}` })),
        getCheckpoint: (topic) => call({ path: '/api/v1/checkpoints', query: { topic } }),
        setCheckpoint: (topic, cursor) => call({ method: 'PUT', path: '/api/v1/checkpoints', json: { topic, cursor } }),
        subscriptions,
        subscribe: subscriptions.create,
        /** Operators (events.delivery.admin): { deliveries, counts }. */
        deliveries: ({ status, subscriptionId, afterSeq, limit } = {}) => call({
            path: '/api/v1/deliveries', query: { status, subscription_id: subscriptionId, after_seq: afterSeq, limit },
        }),
        /** Requeue retained events for one subscription: { subscriptionId, fromSeq } | { subscriptionId, eventIds }. */
        replay: ({ subscriptionId, fromSeq, eventIds } = {}) => call({
            method: 'POST', path: '/api/v1/deliveries/replay', idempotencyKey: false,
            json: { subscription_id: subscriptionId, from_seq: fromSeq, event_ids: eventIds },
        }),
    };
}

// ── Developer apps ───────────────────────────────────────────
//
// OpenVibe.Events rules for an app token (sub app:app_<ULID>, project_id prj_<ULID>, env):
//   event_type  app.<project_key>.<name…>   project_key = 'p' + the project's ULID in lowercase
//   source      app-<the app's ULID in lowercase>
//   actor       { type: 'app', id: app_… } or the user the token acts for (on_behalf_of)
//   reads       own project in the token's env + public first-party events; every topic pattern
//               starts with a literal segment and app.* patterns name the own project_key
//   webhooks    https endpoints on public addresses only
// Realtime (SSE) never streams app events.

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const PROJECT_ID_RE = new RegExp(`^prj_(${ULID})$`);
const APP_ID_RE = new RegExp(`^(?:app:)?app_(${ULID})$`);
const SEGMENT_RE = /^[a-z0-9_]+$/;

/** 'prj_01JAB…' -> 'p01jab…' (the second segment of the project's event types); null if not a project id. */
function projectKey(projectId) {
    const m = PROJECT_ID_RE.exec(String(projectId || ''));
    return m ? `p${m[1].toLowerCase()}` : null;
}

/** 'app_01JAB…' (or 'app:app_01JAB…') -> 'app-01jab…' (the app's event source); null if not an app id. */
function appSource(appId) {
    const m = APP_ID_RE.exec(String(appId || ''));
    return m ? `app-${m[1].toLowerCase()}` : null;
}

/**
 * An events client scoped to one developer app of one project:
 *
 *   const events = createAppEvents(client, { projectId: 'prj_…', appId: 'app_…' });
 *   await events.publish({ event_type: 'order.shipped', subject: { type: 'order', id: 'o1' }, payload });
 *     // -> app.<project_key>.order.shipped, source app-<ulid>, actor { type: 'app', id: 'app_…' }
 *   await events.pull({ topic: 'order.*' })                      // app.<project_key>.order.*
 *   await events.pull({ topic: '*', platformTopics: ['live.stream.*'] })   // + public first-party events
 *   await events.subscribe({ topicPattern: '*', endpoint: 'https://hooks.example.com/ov' })
 *
 * Event types and topic patterns are relative to the project (`order.shipped`, `order.*`, `*`);
 * a full `app.<project_key>.…` name is kept as it is, and a name under another project's key
 * throws. `onBehalfOf` (a usr_… id, the token's on_behalf_of) makes that person the default actor.
 * `subject` defaults to the app. First-party topics go in `platformTopics` (reads only).
 */
function createAppEvents(client, { projectId, appId, onBehalfOf, baseUrl } = {}) {
    const key = projectKey(projectId);
    if (!key) throw new TypeError('createAppEvents: projectId must be prj_<ULID>');
    const source = appSource(appId);
    if (!source) throw new TypeError('createAppEvents: appId must be app_<ULID>');
    const app = String(appId).replace(/^app:/, '');
    const prefix = `app.${key}.`;
    const events = createEventsClient(client, { source, baseUrl });

    /** A project-relative name or pattern -> the full one. */
    function topic(name) {
        const s = String(name == null ? '' : name).trim();
        if (!s) throw new TypeError('an event type or topic pattern is required');
        if (s === `app.${key}` || s.startsWith(prefix)) return s;
        if (s === 'app' || s.startsWith('app.')) {
            const other = s.split('.')[1];
            if (other && /^p[0-9a-z]{26}$/.test(other)) throw new TypeError(`${s} names another project (this app's types are ${prefix}*)`);
        }
        return `${prefix}${s}`;
    }
    const topics = (t) => (Array.isArray(t) ? t : String(t).split(',')).map((x) => x.trim()).filter(Boolean).map(topic);
    const readTopics = (t, platformTopics = []) => {
        const extra = (Array.isArray(platformTopics) ? platformTopics : [platformTopics]).filter(Boolean).map(String);
        for (const p of extra) if (p === '*' || p.startsWith('*') || p === 'app' || p.startsWith('app.')) throw new TypeError(`platformTopics are first-party patterns with a literal first segment, not ${p}`);
        return [...topics(t), ...extra];
    };

    function prepare(envelope, opts) {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('an event envelope must be an object');
        if (envelope.source && envelope.source !== source) throw new TypeError(`source must be ${source}`);
        const type = topic(envelope.event_type);
        if (!type.slice(prefix.length).split('.').every((seg) => SEGMENT_RE.test(seg))) throw new TypeError(`${type}: segments are [a-z0-9_]+`);
        const actor = envelope.actor || (onBehalfOf ? { type: 'user', id: onBehalfOf } : { type: 'app', id: app });
        return events.prepare({ ...envelope, event_type: type, source, actor, subject: envelope.subject || { type: 'app', id: app } }, opts);
    }

    return {
        projectId,
        appId: app,
        projectKey: key,
        source,
        prefix,
        topic,
        prepare,
        /** Same as EventsClient.publish, with the app's type prefix, source and actor filled in. */
        publish(input, opts) {
            return events.publish(Array.isArray(input) ? input.map((e) => prepare(e)) : prepare(input), opts);
        },
        pull: ({ topic: t = '*', platformTopics, ...rest } = {}) => events.pull({ ...rest, topic: readTopics(t, platformTopics) }),
        iterate: ({ topic: t = '*', platformTopics, ...rest } = {}) => events.iterate({ ...rest, topic: readTopics(t, platformTopics) }),
        get: (eventId) => events.get(eventId),
        getCheckpoint: (t) => events.getCheckpoint(topic(t)),
        setCheckpoint: (t, cursor) => events.setCheckpoint(topic(t), cursor),
        subscriptions: {
            create: ({ topicPattern = '*', ...rest } = {}) => events.subscriptions.create({ ...rest, topicPattern: topic(topicPattern) }),
            list: () => events.subscriptions.list(),
            get: (id) => events.subscriptions.get(id),
            disable: (id) => events.subscriptions.disable(id),
            enable: (id) => events.subscriptions.enable(id),
        },
        subscribe: ({ topicPattern = '*', ...rest } = {}) => events.subscriptions.create({ ...rest, topicPattern: topic(topicPattern) }),
        /** The underlying EventsClient (no scoping). */
        events,
    };
}

const { createOutbox, createInbox } = require('./outbox');

module.exports = {
    createEventsClient, verifyDelivery, signDelivery, parseDelivery, createOutbox, createInbox,
    projectKey, appSource, createAppEvents, verifyDeliveryV2, signDeliveryV2, signDeliveryHeaders,
};
