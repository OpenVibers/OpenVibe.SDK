'use strict';
/**
 * openvibe-sdk/exchange: OpenVibe.Exchange, the buyer and the seller side of the model exchange
 * (the plan of 2026-11-06, "For builders", item 7).
 *
 * The buyer side speaks the Exchange's v1 API (https://api.openvibe.exchange) with a Network developer key:
 * chat() (streaming and not, the OpenAI shape), models(), offers(model), presets(), usage() and receipt(id).
 * computePrices({ kind }) reads the reviewed compute tariffs from the public site (https://openvibe.exchange),
 * keyless; createComputePriceClient() is that reader on its own, for an app that holds no Exchange key.
 * Every answered request carries a receipt; a request may name a preset, a saved routing profile.
 *
 *   const exchange = createExchangeClient({ developerKey: process.env.OPENVIBE_DEVELOPER_KEY });
 *   const answer = await exchange.chat({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] });
 *   // { id: 'chatcmpl-...', object: 'chat.completion', choices, usage, x_openvibe: { run_id, cost_usd, ... } }
 *   for await (const chunk of exchange.chat({ model: 'openvibe', messages, stream: true })) { ... }
 *
 * The seller side registers an offer in one of two forms. With `machineId`, it reports a Link machine's offer to the
 * Network's user-owned AI offers (POST /internal/ai/offers/report, the capability network.resource.report). With
 * `endpoint` and no machine, it registers a standalone OpenAI-compatible server on the Exchange's public seller API
 * (POST /api/v1/exchange/seller/offers) with the same developer key the buyer side uses; AI reaches that address only
 * through its egress guard (https, a public DNS answer, never an IP literal, a timeout, a response cap, no buyer
 * identity in a header) and verifies it exactly as a machine running Link (canaries, fingerprint, spot re-runs, free tier only
 * until verified, self-dealing earns 0).
 *
 *   const offer = await exchange.seller.offer({
 *       endpoint: 'https://my-server.example/v1',
 *       models: ['qwen3:32b'], price: { in_per_million: 0, out_per_million: 0 },
 *       hours: { start: '18:00', end: '23:30', tz: 'Europe/Lisbon' }, concurrency: 2,
 *   });
 *   // { offer: { id: 'ep_…', offer_id: 'endpoint:ep_…', … }, endpoint: { url, models } }
 *
 *   const nodeOffer = await exchange.seller.offer({
 *       model: 'qwen3:32b', price: 0, hours, concurrency: 2,
 *       machineId: 'dev_…', owner: 'usr_…',
 *   });
 *   const { totals, offers } = await exchange.seller.earnings();
 *
 * A 429 or a 5xx is retried with a jittered backoff (a safe method always, a write only when it is idempotent),
 * and every call takes an AbortSignal.
 *
 * Webhooks (usage, earnings, an offer going down) carry X-OpenVibe-Signature-V2: t=<unix seconds>,
 * v2=<hex HMAC-SHA256 of "<t>.<raw body>">. webhooks.verify checks it in constant time and refuses a timestamp
 * more than 300 s either way; the platform's legacy sha256=<hex> of the body alone is accepted too.
 */

const crypto = require('node:crypto');

/** The Exchange's own origin. */
const EXCHANGE_BASE_URL = 'https://api.openvibe.exchange';
/** The Network's origin: the user-owned AI offers live there. */
const NETWORK_BASE_URL = 'https://api.openvibe.network';
const CATALOG_SEARCH_URL = 'https://openvibe.exchange';
/** How far a signed webhook's timestamp may be from this server's clock, in seconds. */
const SIGNATURE_TOLERANCE_SEC = 300;

/** The statuses a call is retried on: a refusal is not retried, a busy or broken server is. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Where each call goes. A deployment may point another one at these paths. */
const DEFAULT_PATHS = {
    chat: '/v1/chat/completions',
    models: '/v1/models',
    receipts: '/v1/receipts',
    presets: '/api/v1/presets',
    catalog: '/api/v1/exchange/catalog',
    catalogModels: '/api/v1/exchange/models',
    usage: '/api/v1/exchange/usage',
    platformUsage: '/api/v1/usage',
    sell: '/api/v1/community/sell',
    sellerOffers: '/api/v1/exchange/seller/offers',
    offerReport: '/internal/ai/offers/report',
    offerList: '/internal/ai/offers',
    computePrices: '/api/compute/prices',
};

class ExchangeError extends Error {
    constructor(message, { status = null, code = null, body = null, retryAfter = null } = {}) {
        super(message);
        this.name = 'ExchangeError';
        this.status = status;
        this.code = code;
        this.body = body;
        this.retryAfter = retryAfter;
    }
    /** No status (the network, a timeout, a token), 5xx, 429 and 401 are worth retrying; a refusal is not. */
    get retryable() { return this.status == null || this.status >= 500 || this.status === 429 || this.status === 401; }
}

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }

function toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    return Buffer.from(String(raw));
}

function hmac(secret, ...parts) {
    const h = crypto.createHmac('sha256', String(secret));
    for (const p of parts) h.update(p);
    return h.digest('hex');
}

/** Constant-time compare of two lower-case hex digests of the same length. */
function sameHex(given, expected) {
    if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false;
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Parse a signature header into { t, digests[] } (timestamped) or { t: null, digests[] }
 * (body only). Unknown fields are ignored; a malformed or empty header returns null.
 */
function parseSignature(header) {
    const s = String(header || '').trim();
    if (!s) return null;
    const bare = s.match(/^(?:sha256=)?([0-9a-f]{64})$/i);
    if (bare) return { t: null, digests: [bare[1].toLowerCase()] };
    let t = null;
    const digests = [];
    for (const part of s.split(',')) {
        const i = part.indexOf('=');
        if (i < 0) return null;
        const key = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (key === 't') {
            if (t !== null || !/^\d{1,12}$/.test(value)) return null;
            t = Number(value);
        } else if (key === 'v1' || key === 'v2') {
            if (!/^[0-9a-f]{64}$/i.test(value)) return null;
            digests.push(value.toLowerCase());
        }
    }
    if (t === null || !digests.length) return null;
    return { t, digests };
}

/**
 * Verify an Exchange webhook against the RAW request body (never a re-serialised object).
 *
 *   verifyWebhook(rawBody, signatureHeader, secret)
 *   verifyWebhook(rawBody, signatureHeader, secret, { toleranceSec: 300, now: Date.now() })
 *
 * Returns true only for a valid signature; malformed input is false, never an exception.
 */
function verifyWebhook(rawBody, signatureHeader, secret, { toleranceSec = SIGNATURE_TOLERANCE_SEC, now = Date.now() } = {}) {
    if (!Number.isFinite(toleranceSec) || toleranceSec < 0) throw new TypeError('verifyWebhook: toleranceSec must be a number of seconds >= 0');
    if (rawBody == null || typeof signatureHeader !== 'string' || !secret) return false;
    const parsed = parseSignature(signatureHeader);
    if (!parsed) return false;
    let expected;
    if (parsed.t !== null) {
        if (Math.abs(Number(now) / 1000 - parsed.t) > toleranceSec) return false;
        expected = hmac(secret, `${parsed.t}.`, toBuffer(rawBody));
    } else {
        expected = hmac(secret, toBuffer(rawBody));
    }
    let ok = false;
    for (const digest of parsed.digests) if (sameHex(digest, expected)) ok = true;
    return ok;
}

/** A signal that ends when the call's own signal or its timeout does. */
function linkedSignal(signal, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
        signal: controller.signal,
        done() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The backoff before the next attempt: exponential, with a jitter, and never longer than 30 s. */
function backoffMs(attempt, baseMs, random) {
    const ceiling = Math.min(30000, baseMs * Math.pow(2, attempt));
    return Math.round(ceiling * (0.5 + random() * 0.5));
}

function queryOf(query) {
    const parts = [];
    for (const [key, value] of Object.entries(query || {})) {
        if (value == null || value === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
}

/** The error an OpenAI-shaped answer carries: {error: {message, type, code, param}}. */
function openAiError(body, status) {
    const error = body && typeof body === 'object' ? body.error : null;
    if (error && typeof error === 'object') {
        return { message: String(error.message || 'the request failed'), code: error.code || null, type: error.type || null };
    }
    if (body && typeof body === 'object' && (body.detail || body.title || body.code)) {
        return { message: String(body.detail || body.title || body.code), code: body.code || null, type: null };
    }
    return { message: `the request failed with status ${status}`, code: null, type: null };
}

/** The chunks of one SSE block; [DONE] ends the stream. */
function parseSse(block) {
    const out = [];
    for (const line of String(block).split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { out.push(JSON.parse(data)); } catch { /* a partial or unknown event is skipped */ }
    }
    return out;
}

/**
 * The SSE stream of a chat completion, chunk by chunk. The last chunk carries the OpenVibe
 * fields (x_openvibe); the stream ends with data: [DONE].
 */
async function* sseChunks(res) {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await res.text();
        for (const chunk of parseSse(text)) yield chunk;
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const chunk of parseSse(raw)) yield chunk;
            cut = buffer.indexOf('\n\n');
        }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    for (const chunk of parseSse(buffer)) yield chunk;
}

/** The hours an offer is open: {start, end, tz}; start == end is all day and an overnight window wraps. */
function checkHours(hours) {
    const h = hours || {};
    const hhmm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!hhmm.test(String(h.start)) || !hhmm.test(String(h.end))) throw new TypeError('offer.hours: start and end are HH:MM (24-hour)');
    const tz = h.tz == null || h.tz === '' ? 'UTC' : String(h.tz);
    if (tz.length > 64) throw new TypeError('offer.hours: tz is at most 64 characters');
    return { start: String(h.start), end: String(h.end), tz };
}

/** A server address: http(s), no credentials, no trailing slash. The Exchange's endpoint form requires https. */
function endpointUrl(raw) {
    let u;
    try { u = new URL(String(raw == null ? '' : raw)); } catch { throw new TypeError('offer.endpoint: an http(s) URL'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('offer.endpoint: an http(s) URL');
    if (u.username || u.password) throw new TypeError('offer.endpoint: no credentials in the URL');
    return u.toString().replace(/\/+$/, '');
}

/** The credit price per million tokens: a number for both sides, or {in_per_million, out_per_million}. */
function checkPrice(price) {
    const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000;
    if (typeof price === 'number') {
        if (!isAmount(price)) throw new TypeError('offer.price: a price is a number from 0 to 1000000 credits per million tokens');
        return { in_per_million: price, out_per_million: price };
    }
    if (!price || typeof price !== 'object') throw new TypeError('offer.price: a price is a number or {in_per_million, out_per_million}');
    const input = price.in_per_million != null ? price.in_per_million : price.in;
    const output = price.out_per_million != null ? price.out_per_million : price.out;
    if (!isAmount(input) || !isAmount(output)) throw new TypeError('offer.price: in_per_million and out_per_million are numbers from 0 to 1000000');
    return { in_per_million: input, out_per_million: output };
}

/**
 * createExchangeClient({ developerKey, baseUrl, networkUrl, fetchImpl, timeoutMs, maxRetries, retryBaseMs, owner, paths })
 *
 * The developerKey is the Network developer key (Bearer). The networkKey is the key used on the Network's own
 * origin when the seller side reports an offer; it defaults to the developer key. The seller side needs a key
 * that holds the capability network.resource.report.
 */
function createExchangeClient({
    developerKey,
    networkKey = null,
    baseUrl = EXCHANGE_BASE_URL,
    networkUrl = NETWORK_BASE_URL,
    siteUrl = CATALOG_SEARCH_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60000,
    maxRetries = 3,
    retryBaseMs = 250,
    owner = null,
    paths: pathOptions = {},
    random = Math.random,
    agent = null,
} = {}) {
    if (developerKey == null && networkKey == null) throw new TypeError('createExchangeClient: developerKey is required');
    if (developerKey != null && (typeof developerKey !== 'string' || !developerKey)) throw new TypeError('createExchangeClient: developerKey is a non-empty string');
    if (networkKey != null && (typeof networkKey !== 'string' || !networkKey)) throw new TypeError('createExchangeClient: networkKey is a non-empty string');
    if (typeof fetchImpl !== 'function') throw new TypeError('createExchangeClient: no fetch available; pass fetchImpl');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('createExchangeClient: timeoutMs must be a positive number');
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('createExchangeClient: maxRetries must be 0 or more');
    if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) throw new TypeError('createExchangeClient: retryBaseMs must be 0 or more');
    const exchange = trimSlash(baseUrl);
    const network = trimSlash(networkUrl);
    const site = trimSlash(siteUrl);
    if (!/^https?:\/\/[^/]+/i.test(exchange)) throw new TypeError('createExchangeClient: baseUrl is an http(s) origin');
    if (!/^https?:\/\/[^/]+/i.test(network)) throw new TypeError('createExchangeClient: networkUrl is an http(s) origin');
    if (!/^https?:\/\/[^/]+/i.test(site)) throw new TypeError('createExchangeClient: siteUrl is an http(s) origin');
    const paths = { ...DEFAULT_PATHS, ...pathOptions };
    const key = developerKey || networkKey;
    const networkBearer = networkKey || developerKey;

    /** One call: the fetch, the retries and the answer. → { res, json } */
    async function call(method, path, { base = exchange, json, query, headers = {}, signal, accept = 'application/json', idempotent = false, bearer = key } = {}) {
        const url = `${base}${path}${queryOf(query)}`;
        const send = {
            method,
            headers: { Accept: accept, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(agent ? { 'User-Agent': agent } : {}), ...headers },
            body: json !== undefined ? JSON.stringify(json) : undefined,
        };
        const mayRetry = SAFE_METHODS.has(method) || idempotent;
        let attempt = 0;
        for (;;) {
            const link = linkedSignal(signal, timeoutMs);
            let res;
            try {
                res = await fetchImpl(url, { ...send, signal: link.signal });
            } catch (err) {
                link.done();
                if (signal && signal.aborted) throw new ExchangeError('the request was aborted');
                if (attempt < maxRetries && mayRetry) {
                    attempt++;
                    await sleep(backoffMs(attempt - 1, retryBaseMs, random));
                    continue;
                }
                throw new ExchangeError(`the exchange is unreachable: ${err.message}`);
            }
            if (res.ok) {
                if (accept === 'application/json') {
                    const data = await res.json().catch(() => null);
                    link.done();
                    return { res, json: data };
                }
                link.done();
                return { res, json: null };
            }
            const retryAfter = Number(res.headers.get('retry-after'));
            const data = await res.json().catch(() => null);
            link.done();
            if (RETRY_STATUS.has(res.status) && attempt < maxRetries && mayRetry) {
                attempt++;
                const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt - 1, retryBaseMs, random);
                await sleep(wait);
                continue;
            }
            const { message, code } = openAiError(data, res.status);
            throw new ExchangeError(message, { status: res.status, code, body: data, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
        }
    }

    const jsonCall = async (method, path, options) => (await call(method, path, options)).json;

    /** The model doc of the Exchange's public catalog: the offers that serve one model. */
    async function modelDoc(model, { signal } = {}) {
        const slug = String(model == null ? '' : model).trim().toLowerCase();
        if (!slug) throw new TypeError('offers: a model is required');
        const parts = slug.split('/').filter(Boolean);
        const path = parts.length > 1
            ? `${paths.catalogModels}/${parts.map((p) => encodeURIComponent(p)).join('/')}`
            : `${paths.catalogModels}/${encodeURIComponent(slug)}`;
        return await jsonCall('GET', path, { signal });
    }

    const seller = {
        /**
         * Register a community offer: what is served, at what price, when, and how many answers at once.
         *
         * With `machineId`, the offer is reported to the Network's user-owned AI offers - the registry OpenVibe Link's
         * "Offer to the network" uses - with the document that registry validates.
         *   offer({ model, price, hours, concurrency, endpoint, machineId, owner, audience, group, ready, health })
         *
         * With `endpoint` and no machineId, it registers a standalone OpenAI-compatible server on the Exchange's public
         * seller API. The server's address is all the platform needs; the developer key names the owner.
         *   offer({ endpoint, models, price, hours, concurrency, audience, group, name })
         */
        async offer({
            model,
            models = null,
            price,
            hours,
            concurrency,
            endpoint = null,
            endpointKey = null,
            machineId = null,
            owner: offerOwner = null,
            audience = 'everyone',
            group = null,
            name = null,
            ready = true,
            health = null,
            source = 'sdk',
            probe = true,
        } = {}, { signal } = {}) {
            const listed = models != null ? models : (model == null ? [] : [model]);
            if (!Array.isArray(listed) || !listed.length) throw new TypeError('offer.model: a model is required');
            if (listed.some((m) => typeof m !== 'string' || !m || m.length > 200)) throw new TypeError('offer.model: every model is a string of at most 200 characters');
            const machine = String(machineId == null ? '' : machineId).trim();
            const cap = Number(concurrency);
            if (!Number.isInteger(cap) || cap < 1 || cap > 8) throw new TypeError('offer.concurrency: an integer from 1 to 8');
            if (!['everyone', 'followers', 'group'].includes(audience)) throw new TypeError('offer.audience: everyone, followers or group');
            if (audience === 'group' && !(typeof group === 'string' && group.trim())) throw new TypeError('offer.group: a group id is required for the group audience');
            const address = endpoint == null ? null : endpointUrl(endpoint);
            const priced = checkPrice(price);
            const window = checkHours(hours);
            // The endpoint form: a standalone server, registered with the developer key. The server is checked first:
            // it must answer the OpenAI models list (probe: false turns that off).
            if (address && !machine) {
                if (!address.startsWith('https://')) throw new TypeError('offer.endpoint: an https URL is required to sell an endpoint');
                const body = { base_url: address, models: listed, price: priced, hours: window, concurrency: cap, audience };
                if (audience === 'group') body.group = String(group).trim();
                if (name != null) body.name = String(name).trim();
                let checked = null;
                if (probe) checked = await seller.probe({ endpoint: address, key: endpointKey, signal });
                // Each call registers a new offer, so it is never retried (a lost answer must not create two).
                const out = await jsonCall('POST', paths.sellerOffers, { json: body, signal });
                return { offer: out && out.offer ? out.offer : out, endpoint: { url: address, models: checked ? checked.models : null } };
            }
            if (!/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(machine)) throw new TypeError('offer.machineId: a machine id (dev_...) is required, or register an endpoint with offer.endpoint');
            const subject = String(offerOwner || owner || '').trim();
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) throw new TypeError('offer.owner: an owner (usr_...) is required');
            const state = health || { status: 'up', checked_at: new Date().toISOString() };
            if (!['up', 'degraded', 'down'].includes(state.status)) throw new TypeError('offer.health: up, degraded or down');
            // The offer document is the one the registry validates: no field outside its shape is sent.
            const document = {
                offer_id: `ai:${machine}`,
                machine_id: machine,
                owner: subject,
                models: listed,
                hours: window,
                concurrency: cap,
                price: priced,
                audience,
                group: audience === 'group' ? String(group).trim() : (group == null ? undefined : String(group)),
                ready: ready === true,
                health: { status: state.status, checked_at: state.checked_at || new Date().toISOString() },
            };
            if (document.group === undefined) delete document.group;
            // The server is checked before the offer is registered: it must answer the OpenAI models list.
            let checked = null;
            if (address && probe) checked = await seller.probe({ endpoint: address, key: endpointKey, signal });
            const report = await jsonCall('POST', paths.offerReport, {
                base: network,
                bearer: networkBearer,
                json: { source, offers: [document] },
                signal,
                idempotent: true,
            });
            return { offer: document, report, endpoint: address ? { url: address, models: checked ? checked.models : null } : null };
        },

        /** The caller's own endpoint offers, with their verification (the developer key names the owner). */
        async endpointOffers({ signal } = {}) {
            return await jsonCall('GET', paths.sellerOffers, { signal });
        },

        /** Remove one of the caller's endpoint offers; only its owner's key may. */
        async removeEndpointOffer(id, { signal } = {}) {
            const offerId = String(id == null ? '' : id).trim();
            if (!offerId) throw new TypeError('removeEndpointOffer: an id is required');
            return await jsonCall('DELETE', `${paths.sellerOffers}/${encodeURIComponent(offerId)}`, { signal });
        },

        /** Ask a server what it serves: the OpenAI models list at its endpoint. → { models } */
        async probe({ endpoint, key = null, signal } = {}) {
            let url;
            try { url = new URL(String(endpoint || '').replace(/\/+$/, '') + '/models'); } catch { throw new TypeError('probe.endpoint: an http(s) URL'); }
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('probe.endpoint: an http(s) URL');
            const link = linkedSignal(signal, timeoutMs);
            let res;
            try {
                res = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, signal: link.signal });
            } catch (err) {
                link.done();
                throw new ExchangeError(`the endpoint is unreachable: ${err.message}`);
            }
            const data = await res.json().catch(() => null);
            link.done();
            if (!res.ok) {
                const { message, code } = openAiError(data, res.status);
                throw new ExchangeError(message, { status: res.status, code, body: data });
            }
            const list = data && Array.isArray(data.data) ? data.data : [];
            return { models: list.map((m) => (typeof m === 'string' ? m : m && m.id)).filter((m) => typeof m === 'string') };
        },

        /**
         * The seller dashboard: the tokens served, the credits earned, the uptime, the verification and the
         * reputation of every offer. The owner is named in X-OV-Subject.
         */
        async earnings({ owner: earningsOwner = null } = {}, { signal } = {}) {
            const subject = String(earningsOwner || owner || '').trim();
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) throw new TypeError('earnings: an owner (usr_...) is required');
            return await jsonCall('GET', paths.sell, { headers: { 'X-OV-Subject': subject }, signal });
        },

        /** The verification of every offer: canaries, the spot re-runs, the reputation and the uptime. */
        async verification({ owner: verificationOwner = null } = {}, { signal } = {}) {
            const sold = await seller.earnings({ owner: verificationOwner }, { signal });
            const offers = Array.isArray(sold.offers) ? sold.offers : [];
            return {
                owner: sold.owner || null,
                generated_at: sold.generated_at || null,
                offers: offers.map((o) => ({
                    offer_id: o.offer_id,
                    machine_id: o.machine_id,
                    models: o.models || [],
                    health: o.health || null,
                    open_now: o.open_now == null ? null : o.open_now,
                    ready: o.ready === true,
                    verification: o.verification || null,
                    verified: o.verified === true,
                    reputation: o.reputation || 0,
                    free_only: o.free_only !== false,
                    uptime_pct: o.uptime_pct == null ? null : o.uptime_pct,
                })),
            };
        },

        /** The offers the Network holds, whole (the registry's own read). */
        async offers({ owner: offerOwner = null, source: offerSource = null } = {}, { signal } = {}) {
            return await jsonCall('GET', paths.offerList, {
                base: network,
                bearer: networkBearer,
                query: { owner: offerOwner, source: offerSource },
                signal,
            });
        },
    };

    const search = (q, opts = {}) => { const { signal, ...query } = opts; return jsonCall('POST', '/v1/search', { json: { ...query, q }, signal }); };
    search.icons = (q, opts = {}) => { const { signal, ...query } = opts; return jsonCall('POST', '/v1/search/icons', { json: { ...query, q }, signal }); };
    return {
        keys: {
            list: ({ signal } = {}) => jsonCall('GET', '/api/v1/exchange/keys', { signal }),
            create: (input, { signal } = {}) => jsonCall('POST', '/api/v1/exchange/keys', { json: input, signal }),
            revoke: (id, { signal } = {}) => { if (!id) throw new TypeError('keys.revoke: id is required'); return jsonCall('DELETE', '/api/v1/exchange/keys/' + encodeURIComponent(id), { signal }); },
        },
        keyUsage: ({ signal } = {}) => jsonCall('GET', '/api/v1/exchange/key-usage', { signal }),
        deployments: {
            list: ({ signal } = {}) => jsonCall('GET', '/api/v1/exchange/deployments', { signal }),
            create: (input, { signal } = {}) => jsonCall('POST', '/api/v1/exchange/deployments', { json: input, signal }),
            stop: (id, { signal } = {}) => { if (!id) throw new TypeError('deployments.stop: id is required'); return jsonCall('POST', '/api/v1/exchange/deployments/' + encodeURIComponent(id) + '/stop', { signal }); },
        },
        search,
        images: (q, opts = {}) => { const { signal, ...query } = opts; return jsonCall('POST', '/v1/search/images', { json: { ...query, q }, signal }); },
        fetch: (url, { signal } = {}) => jsonCall('POST', '/v1/fetch', { json: { url }, signal }),
        arena: {
            /** Start a blind comparison round using the caller's prompt and pair. */
            async start({ prompt, category = 'chat', entries } = {}, { signal } = {}) {
                if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('arena.start: prompt is required');
                if (!Array.isArray(entries) || entries.length < 2) throw new TypeError('arena.start: at least two entries are required');
                return await jsonCall('POST', '/api/v1/arena/rounds', { json: { prompt, category, entries }, signal });
            },
            /** Submit a blind vote. choice is left, right, tie or both_bad. */
            async vote(roundId, choice, { signal } = {}) {
                if (!roundId) throw new TypeError('arena.vote: roundId is required');
                if (!['left', 'right', 'tie', 'both_bad'].includes(choice)) throw new TypeError('arena.vote: choice must be left, right, tie or both_bad');
                return await jsonCall('POST', `/api/v1/arena/rounds/${encodeURIComponent(roundId)}/votes`, { json: { outcome: choice }, signal });
            },
        },
        /**
         * One chat completion. The body is the OpenAI shape; stream: true answers an async iterable of
         * chunks instead of the finished completion.
         */
        async chat(body, { signal } = {}) {
            if (!body || typeof body !== 'object') throw new TypeError('chat: a body is required');
            const payload = { ...body };
            const stream = payload.stream === true;
            const out = await call('POST', paths.chat, { json: payload, signal, accept: stream ? 'text/event-stream' : 'application/json' });
            if (stream) return sseChunks(out.res);
            return out.json;
        },

        /** The models the Exchange can serve: the OpenAI models list. */
        async models({ signal } = {}) {
            return await jsonCall('GET', paths.models, { signal });
        },

        /** The offers that serve one model: its price, its measured speed and its uptime. */
        async offers(model, { signal } = {}) {
            const doc = await modelDoc(model, { signal });
            return Array.isArray(doc.offers) ? doc.offers : [];
        },

        /** The whole public catalog: every model, its offers, its prices and its speed. */
        async catalog({ signal } = {}) {
            return await jsonCall('GET', paths.catalog, { signal });
        },

        /**
         * The reviewed compute tariffs: per provider and region, the GPU or computer, its hourly and per-second
         * price, the date it was checked and the date it must be reviewed again. Keyless and public; `kind`
         * ('cpu' or 'gpu') filters the list. → { checked_at, prices }
         */
        async computePrices({ kind = null } = {}, { signal } = {}) {
            computeKind(kind);
            const book = await jsonCall('GET', paths.computePrices, { base: site, bearer: null, signal });
            return computeBook(book, kind);
        },

        /** The routing presets: the five built-in ones and the caller's own. */
        presets: {
            /** The presets the caller may name. */
            async list({ signal } = {}) {
                const out = await jsonCall('GET', paths.presets, { signal });
                return Array.isArray(out && out.presets) ? out.presets : [];
            },
            /** Store one of the caller's own presets. → { preset } */
            async create({ name, policy } = {}, { signal } = {}) {
                const presetName = String(name == null ? '' : name).trim().toLowerCase();
                if (!presetName) throw new TypeError('presets.create: a name is required');
                if (!policy || typeof policy !== 'object') throw new TypeError('presets.create: a policy is required');
                const out = await jsonCall('POST', paths.presets, { json: { name: presetName, policy }, signal });
                return out && out.preset ? out.preset : out;
            },
            /**
             * Replace one of the caller's own presets. The platform has no PATCH: a preset is stored under its
             * name, so a second POST with the same name replaces it.
             */
            async update(name, { policy } = {}, { signal } = {}) {
                const presetName = String(name == null ? '' : name).trim().toLowerCase();
                if (!presetName) throw new TypeError('presets.update: a name is required');
                if (!policy || typeof policy !== 'object') throw new TypeError('presets.update: a policy is required');
                const out = await jsonCall('POST', paths.presets, { json: { name: presetName, policy }, signal });
                return out && out.preset ? out.preset : out;
            },
            /** Delete one of the caller's own presets. */
            async remove(name, { signal } = {}) {
                const presetName = String(name == null ? '' : name).trim();
                if (!presetName) throw new TypeError('presets.remove: a name is required');
                return await jsonCall('DELETE', `${paths.presets}/${encodeURIComponent(presetName)}`, { signal });
            },
        },

        /**
         * The caller's key usage by default. With days or scope public, the public aggregate;
         * with from, to or requester, the platform's own usage for that requester,
         * which needs the capability ai.usage.read.
         */
        async usage({ days = null, from = null, to = null, requester = null, scope = 'mine' } = {}, { signal } = {}) {
            if (days == null && !from && !to && !requester && scope === 'mine') return await jsonCall('GET', '/api/v1/exchange/key-usage', { signal });
            if (from || to || requester) {
                return await jsonCall('GET', paths.platformUsage, { query: { from, to, requester }, signal });
            }
            const window = Math.max(1, Math.min(366, Number(days) || 30));
            return await jsonCall('GET', paths.usage, { query: { days: window }, signal });
        },

        /** The receipt of one answered request: the offer, the price, the tokens and why it was chosen. */
        async receipt(id, { signal } = {}) {
            const receiptId = String(id == null ? '' : id).trim();
            if (!receiptId) throw new TypeError('receipt: an id is required');
            const out = await jsonCall('GET', `${paths.receipts}/${encodeURIComponent(receiptId)}`, { signal });
            return out && out.receipt ? out.receipt : out;
        },

        seller,
        webhooks: { verify: verifyWebhook },
        baseUrl: () => exchange,
        networkUrl: () => network,
    };
}

module.exports = {
    createCatalogSearchClient,
    createComputePriceClient,
    createExchangeClient,
    ExchangeError,
    verifyWebhook,
    SIGNATURE_TOLERANCE_SEC,
    EXCHANGE_BASE_URL,
    NETWORK_BASE_URL,
    DEFAULT_PATHS,
    RETRY_STATUS,
};

/** The book's own fields stay; `kind` filters its prices when asked. */
function computeBook(book, kind) {
    const prices = book && Array.isArray(book.prices) ? book.prices : [];
    return { ...(book && typeof book === 'object' ? book : {}), prices: kind ? prices.filter((price) => price && price.kind === kind) : prices };
}
function computeKind(kind) {
    if (kind != null && kind !== 'cpu' && kind !== 'gpu') throw new TypeError("computePrices: kind must be 'cpu' or 'gpu'");
}

/**
 * The keyless compute price reader: one public GET, no key and no account.
 *
 *   const compute = createComputePriceClient();
 *   const { checked_at, prices } = await compute.computePrices({ kind: 'gpu' });
 *
 * baseUrl is Exchange's public site (default https://openvibe.exchange), not the API host. A 429 or a 5xx is
 * retried with the module's jittered backoff; every call takes an AbortSignal.
 */
function createComputePriceClient({ baseUrl = CATALOG_SEARCH_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000, maxRetries = 2, retryBaseMs = 250, random = Math.random, agent = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('createComputePriceClient: no fetch available; pass fetchImpl');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('createComputePriceClient: timeoutMs must be a positive number');
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('createComputePriceClient: maxRetries must be 0 or more');
    const site = trimSlash(baseUrl);
    if (!/^https?:\/\/[^/]+/i.test(site)) throw new TypeError('createComputePriceClient: baseUrl is an http(s) origin');
    return {
        async computePrices({ kind = null } = {}, { signal } = {}) {
            computeKind(kind);
            const url = `${site}${DEFAULT_PATHS.computePrices}`;
            let attempt = 0;
            for (;;) {
                const link = linkedSignal(signal, timeoutMs);
                let res;
                try {
                    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(agent ? { 'User-Agent': agent } : {}) }, signal: link.signal });
                } catch (err) {
                    link.done();
                    if (signal && signal.aborted) throw new ExchangeError('the request was aborted');
                    if (attempt < maxRetries) { attempt++; await sleep(backoffMs(attempt - 1, retryBaseMs, random)); continue; }
                    throw new ExchangeError(`the exchange is unreachable: ${err.message}`);
                }
                const body = await res.json().catch(() => null);
                link.done();
                if (res.ok) return computeBook(body, kind);
                if (RETRY_STATUS.has(res.status) && attempt < maxRetries) { attempt++; await sleep(backoffMs(attempt - 1, retryBaseMs, random)); continue; }
                const { message, code } = openAiError(body, res.status);
                throw new ExchangeError(message, { status: res.status, code, body });
            }
        },
    };
}

/** A public, keyless reader for Exchange's model and provider search. */
function createCatalogSearchClient({ baseUrl = CATALOG_SEARCH_URL, fetchImpl = globalThis.fetch } = {}) {
    return {
        async search(q, filters = {}, { signal } = {}) {
            if (typeof q !== 'string' || q.length > 200) throw new TypeError('q must be a string of at most 200 characters');
            const url = new URL('/api/v1/search', baseUrl);
            for (const [key, value] of Object.entries({ ...filters, q })) if (value != null && value !== '') url.searchParams.set(key, String(value));
            const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
            const body = await res.json();
            if (!res.ok) throw new ExchangeError(body?.detail || body?.error || `Search answered ${res.status}`, { status: res.status, body });
            return body;
        },
    };
}
