'use strict';
/**
 * openvibe-sdk/bot: OpenVibe.Bot robots (/api/v1). Browser-safe.
 *
 * Browsers call as the signed-in person (Network ov_token cookie with credentials: 'include', or
 * a Bearer user JWT); first-party services call with a Network service token (audience
 * openvibe.bot, bot.robot.read / bot.robot.manage / bot.robot.control) and say who they act for:
 *   actingSubject: 'usr_…' | 'gst_…'   -> X-OV-Subject
 * Bot reads X-OV-Subject on the routes a service may act for a person (create a robot, manage,
 * control, streaming). A person's own token acts only as themself: Bot refuses a mismatch rather
 * than ignoring it, so `as()` is for services.
 *
 * Public reads need no token at all: profiles and the robot kits catalogue (GET /profiles,
 * /kits). Pairing (POST /pair) is the agent redeeming a one-time code: the code is the credential,
 * and the call is never retried (a code is one-time, so a lost answer cannot be safely repeated).
 * Every other POST carries an Idempotency-Key (the client generates one when retries are on).
 *
 * Not wrapped: the operator WebSocket (/control — Realtime frames bot.command@1), device
 * bootstrap (POST /devices/bind, a Network node token) and the internal Run -> Bot job dispatch
 * (bot.job.dispatch is service-to-service and is never delegated to people or apps). The signed
 * `/robots/:id/devices` listing is `robots.devices`; credential rotation and revocation are
 * `devices.rotate` / `devices.revoke`.
 */
const { isOpenVibeError } = require('./core/errors');
const { isActingSubjectId } = require('./core/ids');
const { paginate } = require('./core/paginate');

const enc = encodeURIComponent;

/** The header a service uses to say who it acts for: X-OV-Subject. Bot ignores the other X-OV-* ones. */
function actingHeaders({ actingSubject } = {}) {
    const h = {};
    if (actingSubject) {
        if (!isActingSubjectId(actingSubject)) throw new TypeError('actingSubject must be a usr_… or gst_… subject id');
        h['X-OV-Subject'] = actingSubject;
    }
    return h;
}

function createBotClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const pick = (o) => ({ actingSubject: o.actingSubject, signal: o.signal });
    const base = pick(defaults);

    function call(opts, perCall = {}) {
        const acting = { ...base };
        for (const [k, v] of Object.entries(pick(perCall))) if (v !== undefined) acting[k] = v;
        return client.json({
            service: 'bot', baseUrl, audience: 'openvibe.bot', ...opts,
            headers: { ...actingHeaders(acting), ...opts.headers }, signal: acting.signal,
        });
    }
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const once = { idempotencyKey: false };     // a one-time code is its own idempotency: never repeat the call

    const robots = {
        /** { robots } — a person's own robots; a service must name owner (or act as them). */
        list: (query = {}, o = {}) => call({ path: '/api/v1/robots', query }, o),
        /** { robot, role } or null when the robot is gone/unknown. */
        get: (id, o = {}) => orNull(call({ path: `/api/v1/robots/${enc(id)}` }, o)),
        /** { owner?, name?, profile_id?, access_policy?, limits? } -> { robot, pairing } (a one-time code). */
        create: (input = {}, o = {}) => call({ method: 'POST', path: '/api/v1/robots', json: input }, o),
        /** { name?, access_policy?, limits? } -> { robot }. */
        update: (id, patch = {}, o = {}) => call({ method: 'PATCH', path: `/api/v1/robots/${enc(id)}`, json: patch }, o),
        /** Irreversible -> null (204). */
        delete: (id, o = {}) => call({ method: 'DELETE', path: `/api/v1/robots/${enc(id)}` }, o),
        /** A fresh one-time pairing code -> { code, expires_at, installer }. */
        pairingCode: (id, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/pairing-code`, json: {} }, o),
        operators: {
            /** { operators } — owner or operator. */
            list: (id, o = {}) => call({ path: `/api/v1/robots/${enc(id)}/operators` }, o),
            /** { subject, role? } -> { operators } (the owner). */
            add: (id, input, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/operators`, json: input }, o),
            remove: (id, subject, o = {}) => call({ method: 'DELETE', path: `/api/v1/robots/${enc(id)}/operators/${enc(subject)}` }, o),
        },
        /** { devices } — each with `online`. */
        devices: (id, o = {}) => call({ path: `/api/v1/robots/${enc(id)}/devices` }, o),
        /** { audit, next_before } — newest first, paged by `before` (an audit id). The owner, or a service with read. */
        audit: (id, query = {}, o = {}) => call({ path: `/api/v1/robots/${enc(id)}/audit`, query }, o),
        /** Every audit entry, newest first: for await (const entry of robots.iterateAudit(id)) … */
        iterateAudit(id, query = {}, o = {}) {
            const limit = query.limit || 50;
            return paginate(async (before) => {
                const page = await robots.audit(id, { ...query, limit, before }, o);
                return { items: page.audit || [], next: page.next_before };
            }, { cursor: query.before ?? null });
        },
        /** Latch the e-stop -> { robot }. A service needs bot.robot.read and bot.robot.control. */
        estop: (id, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/estop`, json: {} }, o),
        /** Clear the e-stop, owner only (a service needs bot.robot.manage) -> { robot }. */
        clearEstop: (id, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/estop/clear`, json: {} }, o),
        /**
         * { id, kind, value?, ms? } -> { robot_id, result, … }; `id` is Bot's own idempotency key (a
         * repeated id is answered from the cache). A refused command is an OpenVibeError (`code`
         * bot.not_an_operator, bot.cooldown, …) with the HTTP status Bot gives it.
         */
        command: (id, input, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/commands`, json: input }, o),
        streaming: {
            /** The owner's OpenRe toggles (Bot stores no copy). A member read. */
            get: (id, o = {}) => call({ path: `/api/v1/robots/${enc(id)}/streaming` }, o),
            /** { to?, on? } (a service must also act for the owner) -> the new streaming state. */
            set: (id, input = {}, o = {}) => call({ method: 'POST', path: `/api/v1/robots/${enc(id)}/streaming`, json: input }, o),
        },
    };

    return {
        robots,
        devices: {
            /** Rotate a paired device's credential -> { device, credential?, …video } (the credential is shown once). */
            rotate: (id, o = {}) => call({ method: 'POST', path: `/api/v1/devices/${enc(id)}/rotate`, json: {} }, o),
            /** Revoke a device, closing its socket at once -> { device }. Irreversible. */
            revoke: (id, o = {}) => call({ method: 'POST', path: `/api/v1/devices/${enc(id)}/revoke`, json: {} }, o),
        },
        profiles: {
            /** The public robot profiles -> { profiles }. */
            list: (o = {}) => call({ path: '/api/v1/profiles' }, o),
            get: (id, o = {}) => orNull(call({ path: `/api/v1/profiles/${enc(id)}` }, o)),
        },
        kits: {
            /** The public "Get a robot" catalogue -> { kits }. */
            list: (o = {}) => call({ path: '/api/v1/kits' }, o),
            get: (id, o = {}) => orNull(call({ path: `/api/v1/kits/${enc(id)}` }, o)),
        },
        /** The agent redeems a one-time pairing code (the code is the credential; never retried) -> the pair result. */
        pair: (input = {}, o = {}) => call({ method: 'POST', path: '/api/v1/pair', json: input, ...once }, o),
        /** The same client acting for someone else: as('usr_…') or as({ actingSubject }). */
        as(who) {
            const next = typeof who === 'string' ? { actingSubject: who } : { ...who };
            return createBotClient(client, { ...defaults, ...next });
        },
        headers: () => actingHeaders(base),
    };
}

module.exports = { createBotClient, actingHeaders };
