'use strict';
/**
 * openvibe-sdk/events (server): OpenVibe.Events, the durable event backbone.
 * Service token with audience openvibe.events; each route checks one capability:
 *   events.event.publish        publish()
 *   events.event.read           pull(), iterate(), get(), checkpoints
 *   events.subscription.manage  subscriptions.*
 *   events.delivery.admin       deliveries(), replay()
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

/**
 * Verify and parse one delivery: { event, seq, subscriptionId, attempt } or null when the
 * signature does not verify. `headers` is req.headers (or a Fetch Headers).
 */
function parseDelivery(rawBody, headers, secret) {
    const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers && headers[k.toLowerCase()]);
    if (!verifyDelivery(rawBody, get('x-openvibe-signature'), secret)) return null;
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

const { createOutbox, createInbox } = require('./outbox');

module.exports = { createEventsClient, verifyDelivery, signDelivery, parseDelivery, createOutbox, createInbox };
