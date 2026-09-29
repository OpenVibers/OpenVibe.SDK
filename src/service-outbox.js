'use strict';
/**
 * createServiceOutbox: a service's events outbox in one call (the wrapper nine services copied around createPgOutbox:
 * Trade, News, Host, Codes, Blog, Deals, Coupons, VIP, Tips). Rows are written inside the change's own transaction
 * (emit joins the ambient openvibe-sdk/db transaction), so an event exists if and only if its change committed; the
 * relay publishes with the service's token (events.event.publish, audience openvibe.events) when the events URL and the
 * OAuth client secret are set, and otherwise rows wait and status() says the relay is off.
 *
 *   const { createServiceOutbox } = require('openvibe-sdk/events');
 *   const out = createServiceOutbox({
 *       db, source: 'trade',
 *       eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
 *       clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
 *       intervalMs: config.events.intervalMs, log,
 *       eventTypes: ['trade.observation.created', …],              // optional: emit refuses an undeclared type
 *       validate: (env) => contracts.validate('events.event-envelope@1', env),   // optional: refuse a malformed envelope
 *   });
 *   await out.emit(envelope, { traceparent });                      // inside the change's transaction
 *   await out.emitIn(t, envelope, { traceparent });                 // or on an explicit transaction handle
 *   await out.moderationAction({ action, target, actorSubject, reason, details });   // <source>.moderation.action
 *   out.start(); out.stop(); await out.kick(); await out.status();  // → { enabled, pending, rejected, last_error }
 */
const { createClient } = require('./core');
const { createServiceTokenClient } = require('./auth/tokens');

function createServiceOutbox({
    db, source, eventsUrl = null, networkInternalUrl = 'http://127.0.0.1:4000', clientId = null, clientSecret = null,
    table = 'event_outbox', intervalMs, now, fetch: fetchImpl, log = console, eventTypes = null, validate = null,
    autoDiscover, moderationOwnerSubject = true,
} = {}) {
    if (!db) throw new TypeError('createServiceOutbox: db is required');
    if (!source || !/^[a-z][a-z0-9_-]*$/.test(source)) throw new TypeError('createServiceOutbox: source is the service id (e.g. "trade")');
    // Required lazily: ./events requires ./outbox, which stays independent of this helper.
    const { createEventsClient, createPgOutbox } = require('./events');
    const enabled = Boolean(eventsUrl && clientSecret);
    const clientOpts = { baseUrls: { events: eventsUrl || 'http://127.0.0.1:4300' }, retries: 0 };
    if (autoDiscover !== undefined) clientOpts.autoDiscover = autoDiscover;
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${String(networkInternalUrl).replace(/\/+$/, '')}/oauth/token`, clientId: clientId || source, clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (the events URL or the OAuth client secret is unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source });
    const tag = `[${source.charAt(0).toUpperCase()}${source.slice(1)}]`;
    let lastError = null;
    const outbox = createPgOutbox(db, {
        events, table, ...(intervalMs ? { intervalMs } : {}), ...(now ? { now } : {}),
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) (log.warn || log.log).call(log, `${tag} event publish failed (will retry): ${msg}`);
            lastError = msg;
        },
    });
    const declared = eventTypes ? new Set(eventTypes) : null;

    function check(envelope) {
        if (!envelope || typeof envelope !== 'object') throw new TypeError('emit: pass an envelope object');
        if (declared && !declared.has(envelope.event_type)) throw new Error(`undeclared event type ${envelope.event_type}`);
    }
    function checkValid(prepared) {
        if (!validate) return;
        const v = validate(prepared);
        if (v && v.valid === false) {
            const why = (v.errors || []).map((e) => `${e.path || ''} ${e.message || e}`.trim()).join('; ');
            throw new Error(`outbox: invalid envelope for ${prepared.event_type}: ${why}`);
        }
    }

    /** On an explicit transaction handle (or db). Returns the complete envelope (with its event_id). */
    async function emitIn(t, envelope, { traceparent } = {}) {
        check(envelope);
        if (validate) {
            const prepared = events.prepare(envelope, now ? { now: now() } : {});
            checkValid(prepared);
            return await outbox.enqueue(t, prepared, { traceparent });
        }
        return await outbox.enqueue(t, envelope, { traceparent });
    }
    /** Inside the caller's (ambient) transaction. */
    const emit = (envelope, opts) => emitIn(db, envelope, opts);

    /** <source>.moderation.action inside the caller's transaction. target: { type, id, owner_subject? }. Never the content. */
    async function moderationAction({ action, target, actorSubject = null, reason = null, details = {} }, { traceparent } = {}) {
        const t = { type: target.type, id: String(target.id).slice(0, 200), owner_subject: moderationOwnerSubject ? (target.owner_subject || null) : null };
        return await emit({
            event_type: `${source}.moderation.action`,
            actor: actorSubject ? { type: 'user', id: actorSubject } : { type: 'service', id: source },
            subject: { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
            visibility: 'internal',
            payload: { action, target: t, actor_subject: actorSubject || null, reason: reason ? String(reason).slice(0, 500) : null, details: details || {} },
        }, { traceparent });
    }

    return {
        emit, emitIn, moderationAction, outbox, events, enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        async kick() { if (enabled) await outbox.kick(); },
        status: async () => ({ enabled, pending: await outbox.pending(), rejected: await outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createServiceOutbox };
