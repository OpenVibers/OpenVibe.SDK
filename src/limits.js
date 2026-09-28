'use strict';
/**
 * openvibe-sdk/limits — per-actor rate limits at a service's capability boundaries (roadmap WS-R task 4).
 *
 * nginx limits by address; a capability route needs limits by WHO calls it: a service principal, a signed-in
 * person, a developer app, or (only when nobody is signed in) the address. createActorLimiter() gives Express
 * middleware that counts each actor in fixed windows and answers 429 problem+json (`rate_limited`, Retry-After)
 * past a limit, before the route does any work.
 *
 *   const { createActorLimiter } = require('openvibe-sdk/limits');
 *   const limits = createActorLimiter({ limits: { minute: 120, hour: 2000 } });
 *   router.post('/objects', guard, limits('media.object.upload', { minute: 30 }), handler);
 *
 * The actor, in order: req.principal.sub (a verified service or app token: svc:live, app:app_…), then the signed-in
 * person (req.user.subject_id, req.user.id, req.auth.subject), then `ip:<req.ip>`. Pass `actor(req)` to decide it
 * yourself; return null to skip counting (a trusted internal caller). Counters live in this process (a restart
 * forgets them) and are capped (maxActors, oldest forgotten first), so memory stays bounded under a flood.
 * Each limit is { minute?, hour?, day? }; a route's own limits replace the defaults window by window.
 *
 * Shared counters (ADR-035): pass `store: createValkeyLimitStore(valkey)` and every process and host counts one
 * actor together (one atomic script per request: check every window, then count). If Valkey errors, that
 * request is counted by this process's own counters instead, so a Valkey outage never opens the gates nor
 * blocks the service.
 */

const WINDOWS = { minute: 60, hour: 3600, day: 86400 };

function defaultActor(req) {
    const p = req.principal;
    if (p && !p.legacy && typeof p.sub === 'string' && p.sub) return p.sub;
    const u = req.user;
    if (u && (u.subject_id || u.id != null)) return u.subject_id ? `user:${u.subject_id}` : `user:${u.id}`;
    if (req.auth && req.auth.subject) return `user:${req.auth.subject}`;
    return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

function problem(res, retryAfter, detail) {
    res.statusCode = 429;
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Content-Type', 'application/problem+json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ type: 'https://openvibe.network/problems/rate_limited', title: 'Too many requests', status: 429, code: 'rate_limited', error: 'rate_limited', detail, retry_after_seconds: retryAfter }));
}

/**
 * @param {object} [opts]
 * @param {{minute?:number,hour?:number,day?:number}} [opts.limits] defaults for every route
 * @param {(req) => string|null} [opts.actor]
 * @param {number} [opts.maxActors] counters kept (default 50 000)
 * @param {() => number} [opts.now] clock in ms (tests)
 * @param {(e: {actor, name, window, limit}) => void} [opts.onLimited] called on every refusal (metrics, logs)
 * @returns {((name: string, limits?: object) => Function) & { stats(): object, reset(): void }}
 */
function createActorLimiter({ limits = { minute: 120 }, actor = defaultActor, maxActors = 50000, now = () => Date.now(), onLimited = null, store = null, log = console } = {}) {
    for (const w of Object.keys(limits)) if (!WINDOWS[w]) throw new Error(`limits: unknown window ${w}`);
    const counters = new Map();   // `${name}|${actor}` -> { [window]: { start, count } }
    const stats = { allowed: 0, limited: 0, actors: 0 };

    function touch(key) {
        const c = counters.get(key);
        if (c) { counters.delete(key); counters.set(key, c); return c; }
        const fresh = {};
        counters.set(key, fresh);
        if (counters.size > maxActors) counters.delete(counters.keys().next().value);
        stats.actors = counters.size;
        return fresh;
    }

    function middleware(name, own = {}) {
        if (typeof name !== 'string' || !name) throw new Error('limits: every limit names its capability or route');
        const merged = { ...limits, ...own };
        for (const w of Object.keys(merged)) if (!WINDOWS[w]) throw new Error(`limits: unknown window ${w}`);
        const windows = Object.entries(merged).filter(([, max]) => Number.isFinite(max) && max >= 0);
        const refuse = (res, who, worst) => {
            stats.limited++;
            if (onLimited) { try { onLimited({ actor: who, name, window: worst.window, limit: worst.max }); } catch { /* observers never block */ } }
            return problem(res, Math.max(1, worst.retry), `${name}: at most ${worst.max} per ${worst.window} for each caller`);
        };
        return function actorLimit(req, res, next) {
            const who = actor(req);
            if (who == null) return next();
            if (store) {
                const t = Math.floor(now() / 1000);
                return store.hit(name, who, windows.map(([w, max]) => [w, max, WINDOWS[w]]), t).then((r) => {
                    if (r && r.limited) return refuse(res, who, r);
                    stats.allowed++;
                    return next();
                }, (err) => {
                    stats.storeErrors = (stats.storeErrors || 0) + 1;
                    if (stats.storeErrors === 1 || stats.storeErrors % 100 === 0) log.warn(`[limits] shared store failed (${err.message}); counting in this process`);
                    return local(req, res, next, who);
                });
            }
            return local(req, res, next, who);
        };
        function local(req, res, next, who) {
            const t = Math.floor(now() / 1000);
            const c = touch(`${name}|${who}`);
            let worst = null;
            for (const [w, max] of windows) {
                const start = Math.floor(t / WINDOWS[w]) * WINDOWS[w];
                if (!c[w] || c[w].start !== start) c[w] = { start, count: 0 };
                if (c[w].count >= max) {
                    const retry = start + WINDOWS[w] - t;
                    if (!worst || retry > worst.retry) worst = { window: w, max, retry };
                }
            }
            if (worst) return refuse(res, who, worst);
            for (const [w] of windows) c[w].count++;
            stats.allowed++;
            return next();
        }
    }
    middleware.stats = () => ({ ...stats });
    middleware.reset = () => { counters.clear(); stats.actors = 0; };
    return middleware;
}

// Check every window, then count every window, atomically. KEYS: one counter per window.
// ARGV: per window max, ttl (seconds), retry (seconds). Returns {0}, or the exceeded window with the longest
// wait as {index (1-based), retry}, as the in-process counters decide.
const HIT_SCRIPT = `
local n = #KEYS
local worst, wr = 0, -1
for i = 1, n do
  local c = tonumber(redis.call('GET', KEYS[i]) or '0')
  if c >= tonumber(ARGV[(i - 1) * 3 + 1]) then
    local r = tonumber(ARGV[(i - 1) * 3 + 3])
    if r > wr then worst = i; wr = r end
  end
end
if worst > 0 then return {worst, wr} end
for i = 1, n do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[(i - 1) * 3 + 2]) end
end
return {0}`;

/** A shared counter store on Valkey for createActorLimiter({ store }). */
function createValkeyLimitStore(valkey) {
    if (!valkey) return null;
    const c = valkey.client;
    if (typeof c.ovLimitHit !== 'function') c.defineCommand('ovLimitHit', { lua: HIT_SCRIPT });
    return {
        async hit(name, actor, windows, t) {
            const keys = []; const args = [];
            for (const [w, max, len] of windows) {
                const start = Math.floor(t / len) * len;
                keys.push(valkey.key('lim', name, w, String(start), actor));
                args.push(String(max), String(len + 5), String(start + len - t));
            }
            if (!keys.length) return { limited: false };
            const r = await c.ovLimitHit(keys.length, ...keys, ...args);
            if (!r || Number(r[0]) === 0) return { limited: false };
            const [w, max] = windows[Number(r[0]) - 1];
            return { limited: true, window: w, max, retry: Number(r[1]) };
        },
    };
}

module.exports = { createActorLimiter, createValkeyLimitStore, defaultActor, WINDOWS };
