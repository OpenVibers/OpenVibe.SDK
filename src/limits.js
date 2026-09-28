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
function createActorLimiter({ limits = { minute: 120 }, actor = defaultActor, maxActors = 50000, now = () => Date.now(), onLimited = null } = {}) {
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
        return function actorLimit(req, res, next) {
            const who = actor(req);
            if (who == null) return next();
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
            if (worst) {
                stats.limited++;
                if (onLimited) { try { onLimited({ actor: who, name, window: worst.window, limit: worst.max }); } catch { /* observers never block */ } }
                return problem(res, Math.max(1, worst.retry), `${name}: at most ${worst.max} per ${worst.window} for each caller`);
            }
            for (const [w] of windows) c[w].count++;
            stats.allowed++;
            return next();
        };
    }
    middleware.stats = () => ({ ...stats });
    middleware.reset = () => { counters.clear(); stats.actors = 0; };
    return middleware;
}

module.exports = { createActorLimiter, defaultActor, WINDOWS };
