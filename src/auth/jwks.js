'use strict';
/**
 * JWKS keys for offline token verification, kept fresh and never a single point of failure (plan T0/T1: one
 * refresher for every service instead of hand-written copies that swallowed errors).
 *
 *   const client = jwksClient(url, { fetch, log })
 *   await client.keys()            the current keys: fresh ones, or the last good ones while a refresh runs or fails
 *   await client.keysForKid(kid)   refetches when a token names a key we do not have (a rotation), at most every 30 s
 *   client.status()                { ready, keys, fetchedAt, stale, failures, lastError, nextTryAt } for /api/ready
 *   client.start({ intervalMs })   refresh in the background (a timer that does not hold the process open)
 *
 * Behaviour:
 *  - Fresh for `ttlMs` (6 h). After that the cached keys are still served while one refresh runs in the background:
 *    keys rarely change, and a JWKS outage must not turn into rejected sign-ins.
 *  - A failed fetch keeps the last good keys and backs off exponentially (1 s, 2 s, 4 s … 5 min) before the next try,
 *    so a Network restart is not met by a thundering herd.
 *  - A token whose `kid` is unknown triggers a refetch at once (a rotation is honoured immediately), but unknown-kid
 *    refetches are spaced at least `minRefetchMs` (30 s) apart: a flood of made-up kids costs one fetch per 30 s.
 *  - Only state changes are logged (the first failure, the recovery), never every request.
 *  - Without any keys yet (the first fetch failed) `keys()` throws a 503-class error: nothing to verify with.
 */
const crypto = require('node:crypto');
const { OpenVibeError } = require('../core/errors');

const TTL_MS = 6 * 60 * 60 * 1000;
const MIN_REFETCH_MS = 30 * 1000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 300000];

function keysFromJwks(doc) {
    const out = [];
    for (const jwk of (doc && Array.isArray(doc.keys) ? doc.keys : [])) {
        if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
        try { out.push({ kid: jwk.kid || null, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) }); } catch { /* skip unusable key */ }
    }
    if (!out.length && doc && typeof doc.public_key === 'string') {
        try { out.push({ kid: null, key: crypto.createPublicKey(doc.public_key) }); } catch { /* skip */ }
    }
    return out;
}

function createJwksClient(url, { fetch: fetchImpl = globalThis.fetch, log = null, ttlMs = TTL_MS, minRefetchMs = MIN_REFETCH_MS, timeoutMs = 5000, now = () => Date.now() } = {}) {
    const st = { keys: null, fetchedAt: 0, attemptAt: 0, kidAt: 0, failures: 0, nextTryAt: 0, lastError: null, inflight: null, timer: null };
    const warn = (msg) => { try { (log && (log.warn || log.error) || console.warn).call(log || console, msg); } catch { /* never throw from logging */ } };
    const info = (msg) => { try { (log && (log.info || log.log) || (() => {})).call(log || console, msg); } catch { /* */ } };

    function refresh() {
        if (st.inflight) return st.inflight;
        st.attemptAt = now();
        st.inflight = (async () => {
            try {
                const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok) throw new Error(`answered ${res.status}`);
                const keys = keysFromJwks(await res.json());
                if (!keys.length) throw new Error('no usable RS256 key in the document');
                if (st.failures) info(`[openvibe-sdk] JWKS ${url} recovered after ${st.failures} failed fetch${st.failures === 1 ? '' : 'es'}`);
                Object.assign(st, { keys, fetchedAt: now(), failures: 0, nextTryAt: 0, lastError: null });
                return keys;
            } catch (err) {
                st.failures += 1;
                st.lastError = err && err.message ? err.message : String(err);
                st.nextTryAt = now() + BACKOFF_MS[Math.min(st.failures - 1, BACKOFF_MS.length - 1)];
                if (st.failures === 1) warn(`[openvibe-sdk] JWKS ${url} fetch failed (${st.lastError}); ${st.keys ? 'serving the last good keys' : 'no keys yet'}, retrying with backoff`);
                if (st.keys) return st.keys;
                throw new OpenVibeError({ code: 'token.no_key', status: 503, message: `JWKS ${url}: ${st.lastError}` });
            } finally { st.inflight = null; }
        })();
        return st.inflight;
    }

    const due = () => now() >= st.nextTryAt;

    async function keys() {
        if (!st.keys) {
            // Nothing cached: fetch now (or wait out the backoff window by failing fast with the last error).
            if (!due() && st.lastError) throw new OpenVibeError({ code: 'token.no_key', status: 503, message: `JWKS ${url}: ${st.lastError}` });
            return await refresh();
        }
        // Stale: serve what we have, refresh in the background (unless backing off).
        if (now() - st.fetchedAt >= ttlMs && due() && !st.inflight) refresh().catch(() => { /* logged in refresh */ });
        return st.keys;
    }

    async function keysForKid(kid) {
        const have = await keys();
        if (!kid || have.some((k) => k.kid === kid)) return have;
        // A legacy document without kids (Network's public_key) can never name one: refetching would change nothing.
        if (have.every((k) => k.kid == null)) return have;
        // An unknown kid: a rotation, or garbage. Unknown-kid refetches are spaced minRefetchMs apart, never inside a
        // backoff, and one already running is joined.
        if (st.inflight) return await st.inflight;
        if (now() - st.kidAt < minRefetchMs || !due()) return have;
        st.kidAt = now();
        return await refresh();
    }

    function status() {
        return { url, ready: !!(st.keys && st.keys.length), keys: st.keys ? st.keys.length : 0, fetchedAt: st.fetchedAt || null,
            stale: !!st.keys && now() - st.fetchedAt >= ttlMs, failures: st.failures, lastError: st.lastError, nextTryAt: st.nextTryAt || null };
    }

    function start({ intervalMs = 15 * 60 * 1000 } = {}) {
        if (st.timer) return api;
        const tick = () => { if (due()) refresh().catch(() => { /* logged */ }); };
        tick();
        st.timer = setInterval(tick, intervalMs);
        if (st.timer.unref) st.timer.unref();
        return api;
    }
    function stop() { if (st.timer) clearInterval(st.timer); st.timer = null; }

    const api = { url, keys, keysForKid, refresh, status, start, stop };
    return api;
}

// One client per URL for the process: verifyUserToken/verifyAppToken share it, and services read its status.
const clients = new Map();
function jwksClient(url, opts = {}) {
    let c = clients.get(url);
    if (!c) { c = createJwksClient(url, opts); clients.set(url, c); }
    return c;
}
/** Status of every JWKS client this process uses (for /api/ready). */
function jwksStatus() { return [...clients.values()].map((c) => c.status()); }

module.exports = { createJwksClient, jwksClient, jwksStatus, keysFromJwks, _clients: clients };
