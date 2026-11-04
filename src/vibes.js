'use strict';
/**
 * openvibe-sdk/vibes (server): Vibes Pay for developer apps (MONEY.md, D12).
 *
 * An app creates a charge from its server with its app token (capability billing.vibes.charge); the
 * person pays on OpenVibe's pay sheet in whole Vibes; Billing moves them once to the project's Vibes
 * wallet and tells the app by a signed webhook and by GET /api/v1/vibes/charges/:id.
 *
 *   const { createVibesClient } = require('openvibe-sdk/vibes');
 *   const vibes = createVibesClient({ appToken: process.env.OPENVIBE_APP_TOKEN, billingUrl: 'https://billing.openvibe.network' });
 *   const charge = await vibes.charges.create({ amount: 50, description: 'Sticker pack: Neon cats',
 *       reference: 'order_123', return_url: 'https://myapp.example/thanks' });
 *   // { id, pay_url, status: 'pending', expires_at }
 *   const paid = await vibes.charges.get(charge.id);
 *   await vibes.charges.refund(charge.id, { reason: 'requested by the buyer' });
 *
 * Webhooks carry X-OpenVibe-Signature-V2: t=<unix seconds>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">.
 * webhooks.verify checks it in constant time and rejects a timestamp more than 300 s either way;
 * it also accepts the platform's legacy sha256=<hex> of the body alone (no timestamp, replayable).
 *
 * Money is whole Vibes, an integer. A float is refused before any request is sent.
 */

const crypto = require('node:crypto');

/** How far a signed webhook's timestamp may be from this server's clock, in seconds. */
const SIGNATURE_TOLERANCE_SEC = 300;

class VibesError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'VibesError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
    /** No status (network, timeout, token), 5xx, 429 and 401 are worth retrying; a refusal is not. */
    get retryable() { return this.status == null || this.status >= 500 || this.status === 429 || this.status === 401; }
}

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
 * Parse a signature header into `{ t, digests[] }` (timestamped) or `{ t: null, digests[] }`
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
 * Verify a Vibes Pay webhook against the RAW request body (never a re-serialised object).
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

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }

function createVibesClient({ appToken, tokenProvider, billingUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (!billingUrl) throw new TypeError('createVibesClient: billingUrl is required');
    if (appToken == null && !tokenProvider) throw new TypeError('createVibesClient: appToken or tokenProvider is required');
    if (appToken != null && (typeof appToken !== 'string' || !appToken)) throw new TypeError('createVibesClient: appToken is a non-empty string');
    if (typeof fetchImpl !== 'function') throw new TypeError('createVibesClient: no fetch available; pass fetchImpl');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('createVibesClient: timeoutMs must be a positive number');
    const base = trimSlash(billingUrl);
    if (!/^https?:\/\/[^/]+/i.test(base)) throw new TypeError('createVibesClient: billingUrl is an http(s) origin');

    async function authHeaders() {
        if (appToken) return { Authorization: `Bearer ${appToken}` };
        const ctx = { service: 'billing', audience: 'openvibe.billing' };
        let out;
        try {
            if (typeof tokenProvider === 'function') out = await tokenProvider(ctx);
            else if (typeof tokenProvider.authHeaders === 'function') out = await tokenProvider.authHeaders(ctx);
            else if (typeof tokenProvider.getToken === 'function') out = await tokenProvider.getToken(ctx);
            else throw new TypeError('tokenProvider needs getToken() or authHeaders()');
        } catch (e) {
            throw new VibesError(`token: ${e.message || e}`);
        }
        if (typeof out === 'string' && out) return { Authorization: `Bearer ${out}` };
        if (out && typeof out === 'object') {
            if (typeof out.Authorization === 'string' || typeof out.authorization === 'string') return out;
            if (typeof out.token === 'string' && out.token) return { Authorization: `Bearer ${out.token}` };
        }
        throw new VibesError('token: the token provider answered no token');
    }

    function invalidate() {
        try {
            if (tokenProvider && typeof tokenProvider.invalidate === 'function') tokenProvider.invalidate({ service: 'billing', audience: 'openvibe.billing' });
        } catch { /* the next call asks for a fresh token anyway */ }
    }

    async function call(method, path, { body, key, retried = false } = {}) {
        let auth;
        try { auth = await authHeaders(); } catch (e) { throw e instanceof VibesError ? e : new VibesError(String(e.message || e)); }
        const headers = { Accept: 'application/json', ...auth };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (key) headers['Idempotency-Key'] = key;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method, headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            throw new VibesError(`Billing unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried && tokenProvider) {
            invalidate();
            return call(method, path, { body, key, retried: true });
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (data && (data.code || data.error)) || `http_${res.status}`;
            throw new VibesError(`Billing ${res.status} ${code}: ${(data && data.detail) || ''}`.trim(), { status: res.status, code, body: data });
        }
        return data;
    }

    const id = (value, label) => {
        const s = String(value == null ? '' : value).trim();
        if (!s) throw new TypeError(`charges.${label}: a charge id is required`);
        return encodeURIComponent(s);
    };

    return {
        charges: {
            /**
             * Create a charge. `amount` is a whole number of Vibes; `reference` is the app's order id
             * and the idempotency key; `return_url` is where the pay sheet sends the person afterwards.
             * Resolves { id, pay_url, status: 'pending', expires_at }.
             */
            async create({ amount, description, reference, return_url } = {}) {
                if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('charges.create: amount is a positive whole number of Vibes');
                const desc = String(description == null ? '' : description).trim();
                if (!desc) throw new TypeError('charges.create: description is required');
                const ref = String(reference == null ? '' : reference).trim();
                if (!ref) throw new TypeError('charges.create: reference is required');
                let returnUrl;
                if (return_url != null) {
                    returnUrl = String(return_url).trim();
                    let u;
                    try { u = new URL(returnUrl); } catch { throw new TypeError('charges.create: return_url is a URL'); }
                    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('charges.create: return_url is an http(s) URL');
                }
                return await call('POST', '/api/v1/vibes/charges', {
                    body: { amount, description: desc, reference: ref, ...(returnUrl ? { return_url: returnUrl } : {}) },
                    key: ref,
                });
            },
            /** The charge as Billing has it: { id, amount, status, reference, ... }. */
            async get(chargeId) {
                return await call('GET', `/api/v1/vibes/charges/${id(chargeId, 'get')}`);
            },
            /** Refund a paid charge: its Vibes return to the person from the project's wallet. */
            async refund(chargeId, { reason } = {}) {
                const text = reason == null ? '' : String(reason).trim();
                return await call('POST', `/api/v1/vibes/charges/${id(chargeId, 'refund')}/refund`, {
                    body: text ? { reason: text.slice(0, 500) } : {},
                });
            },
        },
        webhooks: { verify: verifyWebhook },
        baseUrl: () => base,
    };
}

module.exports = { createVibesClient, VibesError, verifyWebhook, SIGNATURE_TOLERANCE_SEC };
