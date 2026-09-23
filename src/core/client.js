'use strict';
/**
 * createClient(): the one HTTP client every SDK subpath uses. Browser-safe (global fetch, Web
 * Crypto, no Node modules).
 *
 *   - service origins come from explicit `baseUrls` or from the registry (`discover()`); callers
 *     name a service ('media', 'events', …) and a path, never a hard-coded host
 *   - every call has a deadline (`timeoutMs` per attempt, `deadlineMs` for the whole call)
 *   - retries only when repeating is safe: idempotent methods, or a request carrying an
 *     Idempotency-Key (one is generated for mutations when retries > 0 unless the caller opts out
 *     with `idempotencyKey: false`)
 *   - W3C traceparent + X-OpenVibe-Request-Id on every call
 *   - failures are OpenVibeError (RFC 9457 problem details mapped to code/status/detail/requestId/traceId)
 */
const { OpenVibeError } = require('./errors');
const { startSpan, contextFromHeaders } = require('./trace');
const { newIdempotencyKey, randomHex } = require('./ids');
const { satisfies } = require('./semver');

const DEFAULT_NETWORK = 'https://openvibe.network';
/** Contract releases this SDK version was built and tested against. */
const CONTRACTS_RANGE = '>=0.5.0 <1.0.0';
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRY_STATUS = new Set([408, 425, 429, 502, 503, 504]);

const trimSlash = (s) => String(s).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createClient(options = {}) {
    const shared = { discovery: null, discoveredAt: 0, inflight: null, warned: false };
    return build(normalize(options), shared, {});
}

function normalize(o) {
    const fetchImpl = o.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new TypeError('openvibe-sdk: no fetch available; pass options.fetch');
    const sources = [o.token != null, typeof o.getToken === 'function', Boolean(o.tokenProvider)].filter(Boolean).length;
    if (sources > 1) throw new TypeError('openvibe-sdk: pass only one of token, getToken, tokenProvider');
    const network = trimSlash(o.network || DEFAULT_NETWORK);
    let getToken = null;
    if (typeof o.getToken === 'function') getToken = o.getToken;
    else if (o.tokenProvider) getToken = (ctx) => o.tokenProvider.getToken(ctx);
    let invalidateToken = null;
    if (o.tokenProvider && typeof o.tokenProvider.invalidate === 'function') invalidateToken = (ctx) => o.tokenProvider.invalidate(ctx);
    else if (typeof o.invalidateToken === 'function') invalidateToken = o.invalidateToken;
    return Object.freeze({
        network,
        discoveryUrl: o.discoveryUrl || `${network}/.well-known/openvibe`,
        baseUrls: Object.freeze(Object.fromEntries(Object.entries(o.baseUrls || {}).map(([k, v]) => [k, trimSlash(v)]))),
        audiences: Object.freeze({ ...o.audiences }),
        fetch: fetchImpl,
        timeoutMs: o.timeoutMs ?? 10000,
        deadlineMs: o.deadlineMs ?? 30000,
        retries: o.retries ?? 2,
        retryDelayMs: o.retryDelayMs ?? 250,
        maxRetryDelayMs: o.maxRetryDelayMs ?? 5000,
        token: o.token ?? null,
        getToken,
        invalidateToken,
        headers: Object.freeze({ ...o.headers }),
        credentials: o.credentials,
        discoveryTtlMs: o.discoveryTtlMs ?? 5 * 60 * 1000,
        autoDiscover: o.autoDiscover !== false,
        contractsRange: o.contractsRange || CONTRACTS_RANGE,
        strictContracts: Boolean(o.strictContracts),
        traceparent: o.traceparent || null,
        onWarning: typeof o.onWarning === 'function' ? o.onWarning : (msg) => { if (typeof console !== 'undefined') console.warn(`[openvibe-sdk] ${msg}`); },
    });
}

function build(cfg, shared, ctx) {
    const audienceOf = (service) => cfg.audiences[service] || `openvibe.${service}`;

    function cachedDiscovery() {
        return shared.discovery && Date.now() - shared.discoveredAt < cfg.discoveryTtlMs ? shared.discovery : null;
    }

    /**
     * Read the platform descriptor (GET <network>/.well-known/openvibe) and cache it: service
     * origins, token/JWKS endpoints, and the contracts release the network runs. Concurrent
     * callers share one request.
     */
    async function discover({ force = false } = {}) {
        const fresh = cachedDiscovery();
        if (fresh && !force) return fresh;
        if (!shared.inflight) {
            shared.inflight = (async () => {
                const { data } = await request({ url: cfg.discoveryUrl, auth: false });
                if (!data || typeof data !== 'object' || !Array.isArray(data.services)) {
                    throw new OpenVibeError({ code: 'sdk.bad_response', message: `${cfg.discoveryUrl} is not an OpenVibe platform descriptor` });
                }
                const version = (data.contracts && data.contracts.version) || null;
                const compatible = Boolean(version) && satisfies(version, cfg.contractsRange);
                const origins = {};
                for (const s of data.services) if (s && s.id && s.origin) origins[s.id] = trimSlash(s.origin);
                const out = Object.freeze({
                    issuer: data.issuer || null,
                    tokenEndpoint: data.token_endpoint || null,
                    jwksUri: data.jwks_uri || null,
                    registry: data.registry || null,
                    services: data.services,
                    origins: Object.freeze(origins),
                    contractsVersion: version,
                    contractsRange: cfg.contractsRange,
                    compatible,
                    fetchedAt: new Date().toISOString(),
                    raw: data,
                });
                if (!compatible) {
                    const msg = `network runs openvibe-contracts ${version || '(unknown)'}, this SDK supports ${cfg.contractsRange}`;
                    if (cfg.strictContracts) throw new OpenVibeError({ code: 'sdk.incompatible_contracts', message: msg });
                    if (!shared.warned) { shared.warned = true; cfg.onWarning(msg); }
                }
                shared.discovery = out;
                shared.discoveredAt = Date.now();
                return out;
            })().finally(() => { shared.inflight = null; });
        }
        return shared.inflight;
    }

    /** Origin for a service: explicit baseUrls win, then the registry. */
    async function origin(service) {
        if (cfg.baseUrls[service]) return cfg.baseUrls[service];
        if (service === 'network') return cfg.network;
        let d = cachedDiscovery();
        if (!d && cfg.autoDiscover) d = await discover();
        if (d && d.origins[service]) return d.origins[service];
        throw new OpenVibeError({ code: 'sdk.unknown_service', message: `no base URL for service "${service}" (pass baseUrls.${service} or let discover() find it)` });
    }

    /** Is the service registered and running (alpha or later)? Uses the cached descriptor. */
    async function supports(service) {
        const d = await discover();
        const s = d.services.find((x) => x && x.id === service);
        return Boolean(s && ['alpha', 'beta', 'stable', 'degraded'].includes(s.status));
    }

    async function buildUrl({ url, service, baseUrl, path = '', query } = {}) {
        let u;
        if (url) u = String(url);
        else {
            const base = baseUrl ? trimSlash(baseUrl) : await origin(service || 'network');
            u = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
        }
        if (query) {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) {
                if (v === undefined || v === null || v === false) continue;
                qs.set(k, v === true ? '1' : Array.isArray(v) ? v.join(',') : String(v));
            }
            const s = qs.toString();
            if (s) u += (u.includes('?') ? '&' : '?') + s;
        }
        return u;
    }

    async function tokenFor(service, audience) {
        if (cfg.token != null) return cfg.token;
        if (cfg.getToken) return (await cfg.getToken({ service, audience })) || null;
        return null;
    }

    function currentTraceparent() {
        if (ctx.traceparent) return ctx.traceparent;
        return typeof cfg.traceparent === 'function' ? cfg.traceparent() : cfg.traceparent;
    }

    function backoff(attempt) {
        const base = Math.min(cfg.maxRetryDelayMs, cfg.retryDelayMs * 2 ** (attempt - 1));
        return Math.round(base / 2 + Math.random() * base / 2);
    }

    function retryAfterMs(headers) {
        const v = headers && headers.get('retry-after');
        if (!v) return null;
        const s = Number(v);
        const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
        return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, cfg.maxRetryDelayMs) : null;
    }

    /**
     * request({ service | baseUrl | url, path, method, query, json | form | urlencoded | body,
     *           headers, token, auth, audience, idempotencyKey, idempotent, retries, timeoutMs,
     *           deadlineMs, signal, traceparent, requestId, responseType })
     *   -> { status, headers, data, requestId, traceId, traceparent, attempts }
     */
    async function request(opts = {}) {
        const method = String(opts.method || 'GET').toUpperCase();
        const url = await buildUrl(opts);
        const retries = Math.max(0, opts.retries ?? cfg.retries);
        let idem = opts.idempotencyKey;
        if (idem === undefined && !IDEMPOTENT.has(method) && !opts.idempotent && retries > 0) idem = newIdempotencyKey();
        if (idem === false || idem === undefined) idem = null;
        const canRetry = IDEMPOTENT.has(method) || Boolean(idem) || opts.idempotent === true;
        const span = startSpan(opts.traceparent || currentTraceparent());
        const requestId = opts.requestId || ctx.requestId || `req_${randomHex(12)}`;
        const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
        const deadline = Date.now() + (opts.deadlineMs ?? cfg.deadlineMs);
        const service = opts.service;
        const audience = opts.audience || (service ? audienceOf(service) : undefined);
        const meta = { method, url, requestId, traceId: span.traceId };

        let attempt = 0;
        let reauthed = false;
        for (;;) {
            const headers = new Headers({ Accept: 'application/json' });
            for (const src of [cfg.headers, ctx.headers, opts.headers]) {
                for (const [k, v] of Object.entries(src || {})) if (v !== undefined && v !== null) headers.set(k, String(v));
            }
            headers.set('traceparent', span.traceparent);
            headers.set('X-OpenVibe-Request-Id', requestId);
            if (idem) headers.set('Idempotency-Key', idem);
            if (opts.auth !== false && !headers.has('authorization')) {
                const t = opts.token !== undefined ? opts.token : await tokenFor(service, audience);
                if (t) headers.set('Authorization', `Bearer ${t}`);
            }
            const body = encodeBody(opts, headers);
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new OpenVibeError({ ...meta, code: 'sdk.deadline_exceeded', message: `${method} ${url.split('?')[0]}: deadline exceeded after ${attempt} attempt(s)` });

            let out;
            try {
                out = await attemptOnce(cfg.fetch, url, { method, headers, body, credentials: opts.credentials ?? cfg.credentials, signal: opts.signal, responseType: opts.responseType }, Math.min(timeoutMs, remaining), meta);
            } catch (err) {
                if (err.code === 'sdk.aborted' || !canRetry || attempt >= retries) throw err;
                const wait = backoff(attempt + 1);
                if (Date.now() + wait >= deadline) throw err;
                attempt++;
                await sleep(wait);
                continue;
            }
            const { res, data } = out;
            if (res.status === 401 && !reauthed && opts.auth !== false && opts.token === undefined && cfg.invalidateToken) {
                reauthed = true;     // a rejected token was never acted on: refresh it and try once more
                await cfg.invalidateToken({ service, audience });
                continue;
            }
            const retryable = RETRY_STATUS.has(res.status);
            if (!res.ok && retryable && canRetry && attempt < retries) {
                const wait = retryAfterMs(res.headers) ?? backoff(attempt + 1);
                if (Date.now() + wait < deadline) {
                    attempt++;
                    await sleep(wait);
                    continue;
                }
            }
            const rid = res.headers.get('x-openvibe-request-id') || requestId;
            if (!res.ok) throw OpenVibeError.fromResponse({ status: res.status, body: data, requestId: rid, traceId: span.traceId, method, url, retryable });
            return { status: res.status, headers: res.headers, data, requestId: rid, traceId: span.traceId, traceparent: span.traceparent, attempts: attempt + 1 };
        }
    }

    const client = {
        request,
        /** request() but resolves to the parsed body only. */
        async json(opts) { return (await request(opts)).data; },
        discover,
        discovery: () => cachedDiscovery(),
        origin,
        supports,
        url: buildUrl,
        audienceOf,
        traceparent: currentTraceparent,
        /** A client that continues an incoming request's trace ({ traceparent, requestId, headers }). */
        withContext(c = {}) {
            const next = { ...ctx };
            if (c.traceparent) next.traceparent = c.traceparent;
            if (c.requestId) next.requestId = c.requestId;
            if (c.headers) next.headers = { ...ctx.headers, ...c.headers };
            return build(cfg, shared, next);
        },
        /** withContext() from an incoming request's headers (Node req.headers or a Fetch Headers). */
        fromRequest(req) {
            return client.withContext(contextFromHeaders(req && req.headers ? req.headers : req));
        },
        options: cfg,
    };
    return client;
}

function encodeBody(opts, headers) {
    if (opts.json !== undefined) {
        if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
        return JSON.stringify(opts.json);
    }
    if (opts.form !== undefined) return opts.form;     // FormData: fetch sets the multipart boundary
    if (opts.urlencoded !== undefined) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
        const p = opts.urlencoded instanceof URLSearchParams ? opts.urlencoded : new URLSearchParams(Object.entries(opts.urlencoded).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
        return p.toString();
    }
    return opts.body;
}

/** One fetch with its own timeout, covering the body read too. */
async function attemptOnce(fetchImpl, url, { method, headers, body, credentials, signal, responseType }, ms, meta) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        const init = { method, headers, body, signal: ctrl.signal };
        if (credentials) init.credentials = credentials;
        const res = await fetchImpl(url, init);
        if (responseType === 'response') return { res, data: null };
        return { res, data: await parseBody(res, responseType) };
    } catch (err) {
        if (signal && signal.aborted) throw new OpenVibeError({ ...meta, code: 'sdk.aborted', message: `${method} ${url.split('?')[0]}: aborted`, cause: err });
        if (timedOut) throw new OpenVibeError({ ...meta, code: 'sdk.timeout', retryable: true, message: `${method} ${url.split('?')[0]}: no response within ${ms} ms`, cause: err });
        if (err && err.name === 'OpenVibeError') throw err;
        throw new OpenVibeError({ ...meta, code: 'sdk.network_error', retryable: true, message: `${method} ${url.split('?')[0]}: ${err && err.message ? err.message : 'network error'}`, cause: err });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function parseBody(res, responseType) {
    if (res.status === 204 || res.status === 205 || res.status === 304) return null;
    if (responseType === 'text') return res.text();
    if (responseType === 'arrayBuffer') return res.arrayBuffer();
    const text = await res.text();
    if (!text) return null;
    const type = res.headers.get('content-type') || '';
    if (responseType === 'json' || /[/+]json\b/.test(type)) {
        try { return JSON.parse(text); } catch { return text; }
    }
    return text;
}

module.exports = { createClient, CONTRACTS_RANGE, DEFAULT_NETWORK, IDEMPOTENT_METHODS: IDEMPOTENT, RETRY_STATUS };
