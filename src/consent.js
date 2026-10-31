'use strict';
/**
 * openvibe-sdk/consent — may a purpose use these people's content? (L24, 2026-10-31; Contracts 0.256.0
 * network.consent@1.)
 *
 * Nothing a person makes is off-limits to AI or data use by design: each use is OFF until that person turns it on in
 * OpenVibe.Network. A service asks this check before every use of a person's content or likeness, and never assumes.
 *
 *   const { createConsent } = require('openvibe-sdk/consent');
 *   const tokens = createServiceTokenClient({ clientId: 'ai', clientSecret, audience: 'openvibe.network' });
 *   const consent = createConsent({ networkUrl, token: () => tokens.getToken() });
 *
 *   if (await consent.allowed(author, 'ai.train', { kind: 'vods' })) build(author);
 *   const authors = await consent.filter(authors, 'ai.train', { kind: 'chat' });
 *   events.on('network.consent.changed', consent.onChange);      // a revocation applies on the next check
 *
 * It FAILS CLOSED: a network error, a timeout (2 s by default), a non-200 answer, a malformed answer or a token that
 * cannot be minted means FALSE for everyone asked. A failure is never cached as a yes; the next call asks again. It
 * logs at most once a minute. An answer is cached for ttlMs (60 s by default), per subject, purpose, kind, client and
 * feature; network.consent.changed drops that subject's answers for the purpose at once. A cached "no" is dropped the
 * same way, so a person who turns a purpose on does not wait for the TTL.
 *
 * filter() asks in batches of 500 (the check's limit), in input order. mock() is for tests: it answers from a map and
 * never touches the network. `fetch` and `log` may be injected; `now` is for tests.
 */
const PURPOSES = Object.freeze(['ai.train', 'data.public', 'face.recognize', 'app.data']);
const KINDS = Object.freeze(['streams', 'vods', 'clips', 'voice', 'chat', 'posts', 'pictures', 'code']);
const FEATURES = Object.freeze(['verify', 'find', 'cast', 'library']);
const MAX_SUBJECTS = 500;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const LOG_EVERY_MS = 60_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The consent client.
 *   networkUrl  OpenVibe.Network's base URL (no trailing slash needed)
 *   token       () => a service token, or a Promise of one (it needs network.consent.read)
 *   ttlMs       how long an answer is cached (default 60 s; 0 disables the cache)
 *   fetch       the fetch implementation (default globalThis.fetch)
 *   log         { warn } used at most once a minute on failures (default console; null silences)
 *   timeoutMs   the 2 s timeout of one check (tests may shorten it)
 *   now         the clock in ms (tests only)
 */
function createConsent({ networkUrl, token, ttlMs = DEFAULT_TTL_MS, fetch: fetchImpl = globalThis.fetch, log = console, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
    if (!networkUrl || typeof networkUrl !== 'string') throw new TypeError('createConsent: networkUrl is required');
    if (typeof token !== 'function') throw new TypeError('createConsent: token must be a function returning a service token');
    if (typeof fetchImpl !== 'function') throw new TypeError('createConsent: a fetch implementation is required');
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('createConsent: ttlMs must be a number of milliseconds');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('createConsent: timeoutMs must be a positive number');
    const base = String(networkUrl).replace(/\/+$/, '');
    const cache = new Map();   // key -> { subject, purpose, allowed, expires }
    let generation = 0;        // bumped by onChange/mock/clear: a response started before is never cached
    let lastLog = -Infinity;
    let mocked = null;         // Map<subject, Set<purpose>> while mock() is on

    const logOnce = (message) => {
        const at = now();
        if (at - lastLog < LOG_EVERY_MS) return;
        lastLog = at;
        if (log && typeof log.warn === 'function') log.warn(`[consent] ${message}; treating every subject as not allowed`);
    };

    const optKey = (opts) => {
        const o = isObject(opts) ? opts : {};
        return [o.kind || '', o.client || '', o.feature || ''].join('\u0000');
    };
    const keyOf = (subject, purpose, opts) => [subject, purpose, optKey(opts)].join('\u0001');

    function fresh(key) {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expires <= now()) { cache.delete(key); return undefined; }
        return entry.allowed;
    }

    function remember(key, subject, purpose, allowed, startedAtGeneration) {
        if (startedAtGeneration !== generation || ttlMs <= 0) return;
        cache.set(key, { subject, purpose, allowed, expires: now() + ttlMs });
        // Bounded like the other SDK caches: a dataset build over many people must not grow forever.
        if (cache.size > 10_000) {
            const t = now();
            for (const [k, e] of cache) if (e.expires <= t) cache.delete(k);
            while (cache.size > 10_000) cache.delete(cache.keys().next().value);
        }
    }

    /** One POST /internal/consent/check for at most 500 people. → { subject: boolean } or null. */
    async function askBatch(purpose, opts, subjects) {
        const body = { purpose, subjects };
        if (opts && opts.kind) body.kind = String(opts.kind);
        if (opts && opts.client) body.client = String(opts.client);
        if (opts && opts.feature) body.feature = String(opts.feature);
        const controller = new AbortController();
        let timer = null;
        // The deadline covers the token and the answer, not just the socket: a token endpoint that never answers is
        // as closed as a Network that does not. A fetch that ignores the signal is raced, so it cannot hang the call.
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(Object.assign(new Error('consent check timed out'), { name: 'AbortError' }));
            }, timeoutMs);
        });
        const work = (async () => {
            const bearer = await token();
            if (!bearer) throw new Error('no service token');
            const res = await fetchImpl(`${base}/internal/consent/check`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}` },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res || res.status !== 200) return { answered: false, status: res ? res.status : 0 };
            const data = await res.json().catch(() => null);
            return { answered: true, data };
        })();
        work.catch(() => {});   // the race below sees it; this only prevents an unhandled rejection if the deadline won
        try {
            const out = await Promise.race([work, deadline]);
            if (!out.answered) {
                logOnce(`the check answered ${out.status || 'nothing'}`);
                return null;
            }
            const data = out.data;
            if (!isObject(data) || data.purpose !== purpose || !isObject(data.allowed)) {
                logOnce('the check answered something that is not network.consent-check-result@1');
                return null;
            }
            const allowed = {};
            for (const subject of subjects) {
                const value = data.allowed[subject];
                if (value !== undefined && typeof value !== 'boolean') {
                    logOnce('the check answered a non-boolean for a subject');
                    return null;
                }
                allowed[subject] = value === true;
            }
            return allowed;
        } catch (err) {
            const why = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR') ? `timed out after ${timeoutMs} ms` : `failed (${err && err.message ? err.message : err})`;
            logOnce(why);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * May `purpose` use each of these people? → { subject: boolean }. Only the cached answers and the batches that
     * answered at all appear; a failed batch is false for its people and is not cached.
     */
    async function answers(subjects, purpose, opts) {
        const list = [...new Set((Array.isArray(subjects) ? subjects : [subjects]).filter((s) => typeof s === 'string' && s))];
        const out = {};
        if (!PURPOSES.includes(purpose)) {
            logOnce(`unknown purpose '${String(purpose).slice(0, 40)}'`);
            for (const subject of list) out[subject] = false;
            return out;
        }
        if (mocked) {
            for (const subject of list) out[subject] = !!mocked.get(subject) && mocked.get(subject).has(purpose);
            return out;
        }
        const misses = [];
        for (const subject of list) {
            const hit = fresh(keyOf(subject, purpose, opts));
            if (hit === undefined) misses.push(subject);
            else out[subject] = hit;
        }
        for (let i = 0; i < misses.length; i += MAX_SUBJECTS) {
            const batch = misses.slice(i, i + MAX_SUBJECTS);
            const started = generation;
            const answered = await askBatch(purpose, opts, batch);
            for (const subject of batch) {
                const allowed = answered ? answered[subject] === true : false;
                out[subject] = allowed;
                if (answered) remember(keyOf(subject, purpose, opts), subject, purpose, allowed, started);
            }
        }
        return out;
    }

    /** True only for an active choice that covers the purpose, kind, client and feature. False on every doubt. */
    async function allowed(subject, purpose, opts = {}) {
        if (typeof subject !== 'string' || !subject) return false;
        const a = await answers([subject], purpose, opts);
        return a[subject] === true;
    }

    /** The allowed subset of `subjects`, in input order, without duplicates; asked in batches of 500. */
    async function filter(subjects, purpose, opts = {}) {
        const list = [...new Set((Array.isArray(subjects) ? subjects : []).filter((s) => typeof s === 'string' && s))];
        if (!list.length) return [];
        const a = await answers(list, purpose, opts);
        return list.filter((subject) => a[subject] === true);
    }

    /**
     * Drop the answers for one subject and purpose (all kinds, clients and features), so the next check asks again.
     * Accepts the network.consent.changed envelope, its payload, or a bare { subject, purpose }. Without both fields
     * it clears everything (never worse than a full re-check). Returns how many entries were dropped.
     */
    function onChange(event) {
        generation++;
        const p = event && event.payload && typeof event.payload === 'object' ? event.payload : (event || {});
        const subject = p.subject ? String(p.subject) : null;
        const purpose = p.purpose ? String(p.purpose) : null;
        let dropped = 0;
        if (!subject || !purpose) {
            dropped = cache.size;
            cache.clear();
            return dropped;
        }
        for (const [key, entry] of cache) {
            if (entry.subject === subject && entry.purpose === purpose) { cache.delete(key); dropped++; }
        }
        return dropped;
    }

    /** Answer from a map ({ usr_x: ['ai.train'] }) without the network; mock(null) returns to the live check. */
    function mock(map) {
        generation++;
        cache.clear();
        if (map === null || map === undefined) { mocked = null; return api; }
        if (!isObject(map)) throw new TypeError('consent.mock: pass an object of subject → purposes, or null');
        mocked = new Map();
        for (const [subject, purposes] of Object.entries(map)) {
            if (!Array.isArray(purposes)) throw new TypeError(`consent.mock: ${subject} must map to an array of purposes`);
            mocked.set(subject, new Set(purposes.map(String)));
        }
        return api;
    }

    /** Forget every cached answer. */
    function clear() {
        generation++;
        cache.clear();
    }

    const api = { allowed, filter, onChange, mock, clear };
    return api;
}

module.exports = {
    createConsent, PURPOSES, KINDS, FEATURES, MAX_SUBJECTS, DEFAULT_TTL_MS, DEFAULT_TIMEOUT_MS,
};
