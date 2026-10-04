'use strict';
/**
 * openvibe-sdk/commerce (server): the Billing client Tips and VIP share (ADR-012, the only place money moves).
 * One HTTP shape, one retry rule, one error type; the product supplies its capabilities and, in tests, its
 * token clients. Every POST can carry an Idempotency-Key, sent verbatim and unchanged on the one retry after a
 * 401, so a lost response never moves money twice.
 *
 * openvibe-contracts (serviceAuth) is required lazily, only when a token client has to be created, so this
 * module loads from the zero-dependency tarball.
 */

class CommerceError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'CommerceError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
    /** No status (network, timeout, token), 5xx, 429, 401 and a frozen account are worth retrying; the rest are Billing's answer. */
    get retryable() { return this.status == null || this.status >= 500 || this.status === 429 || this.status === 401 || this.code === 'billing.frozen'; }
}

/** A stable Idempotency-Key from a product record: the prefix, then each part that is set, joined with ':'. */
function intentKey(prefix, parts) {
    if (typeof prefix !== 'string' || prefix === '') throw new TypeError('intentKey: a non-empty prefix is required');
    return `${prefix}:${(parts || []).filter((p) => p != null && p !== '').join(':')}`;
}

/** A receipt record for the product's outbox: { kind, at, ...fields } with null/undefined fields stripped. Constructed, never posted. */
function receipt(kind, fields = {}) {
    const out = { kind, at: new Date().toISOString() };
    for (const [k, v] of Object.entries(fields || {})) if (v != null) out[k] = v;
    return out;
}

const user = (id) => ({ type: 'user', id });
const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
};

/**
 * `config`: { billing: { url, audience, timeoutMs = 10000 }, network: { internalUrl }, oauth: { clientId, clientSecret } }.
 * `caps` maps the logical keys intent / transfer / subscription / entitlement (and optionally rates, default
 * entitlement) to capability strings; a client is created per distinct capability string, so two keys that map to
 * one string (or a space-separated scope) share one token. `tokenClients` may be keyed by logical key or by
 * capability string; any other capability gets a serviceAuth token client with scope = the capability.
 */
function createCommerceClient(config, { caps, fetchImpl = globalThis.fetch, tokenClients = null, timeoutMs } = {}) {
    if (!caps || typeof caps !== 'object') throw new TypeError('createCommerceClient: caps is required');
    const base = config.billing.url;
    const deadline = timeoutMs || config.billing.timeoutMs || 10000;
    const capFor = (logical) => caps[logical] || logical;
    const clients = new Map();
    const tokensFor = (logical) => {
        const cap = capFor(logical);
        if (tokenClients && tokenClients[logical]) return tokenClients[logical];
        if (tokenClients && tokenClients[cap]) return tokenClients[cap];
        if (!clients.has(cap)) {
            const { serviceAuth } = require('openvibe-contracts');
            clients.set(cap, serviceAuth.createTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: config.billing.audience,
                scope: cap,
                fetchImpl,
            }));
        }
        return clients.get(cap);
    };

    async function call(logical, method, path, { body, key, traceparent, retried = false } = {}) {
        let auth;
        try { auth = await tokensFor(logical).authHeaders(); } catch (e) { throw new CommerceError(`token (${capFor(logical)}): ${e.message}`); }
        const headers = { Accept: 'application/json', ...auth };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (key) headers['Idempotency-Key'] = key;
        if (traceparent) headers.traceparent = traceparent;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(deadline) });
        } catch (e) {
            throw new CommerceError(`Billing unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried) { tokensFor(logical).invalidate(); return await call(logical, method, path, { body, key, traceparent, retried: true }); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (data && (data.code || data.error)) || `http_${res.status}`;
            throw new CommerceError(`Billing ${res.status} ${code}: ${(data && data.detail) || ''}`.trim(), { status: res.status, code, body: data });
        }
        return data;
    }

    return {
        /** { intent, checkout_url }: kind purchase buys `bits` of credit; kind subscription is a checkout for `subject` to `creator`. */
        createIntent: async ({ provider, kind = 'purchase', subject, bits, creator, autoRenew, successUrl, cancelUrl, key, traceparent }) => await call('intent', 'POST', '/api/v1/intents', {
            body: {
                provider, kind, subject: user(subject),
                ...(kind === 'subscription' ? { streamer: user(creator), auto_renew: !!autoRenew } : { bits }),
                success_url: successUrl, cancel_url: cancelUrl,
            },
            key, traceparent,
        }),
        /** { transaction }: credit of `from` to payable of `to`, tagged with the interaction. */
        createTransfer: async ({ from, to, amount, kind, target, message, key, traceparent }) => await call('transfer', 'POST', '/api/v1/transfers', {
            body: { from: user(from), to: user(to), amount, kind, target, message: message || undefined },
            key, traceparent,
        }),
        refundTransfer: async ({ txnId, amount, reason, key }) => await call('transfer', 'POST', `/api/v1/transfers/${encodeURIComponent(txnId)}/refund`, { body: { amount, reason }, key }),
        /** { subscription, entitlement, transaction }: one period paid from the member's credit. */
        subscribeWithCredit: async ({ subscriber, creator, autoRenew, key, traceparent }) => await call('subscription', 'POST', '/api/v1/subscriptions', {
            body: { subscriber: user(subscriber), streamer: user(creator), source: 'credit', auto_renew: autoRenew !== false },
            key, traceparent,
        }),
        cancelSubscription: async ({ id, key, traceparent }) => await call('subscription', 'POST', `/api/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { body: {}, key, traceparent }),
        getSubscription: async (id) => await call('entitlement', 'GET', `/api/v1/subscriptions/${encodeURIComponent(id)}`),
        listSubscriptions: async ({ streamer, subscriber, status } = {}) => await call('entitlement', 'GET', `/api/v1/subscriptions${qs({ streamer, subscriber, status })}`),
        /** { active, expires_at, subscription }: the authoritative answer. */
        entitlement: async (subject, creator) => await call('entitlement', 'GET', `/api/v1/entitlements/${encodeURIComponent(subject)}${qs({ streamer: creator })}`),
        rates: async () => await call(caps.rates ? 'rates' : 'entitlement', 'GET', '/api/v1/rates'),
        baseUrl: () => base,
    };
}

module.exports = { createCommerceClient, CommerceError, intentKey, receipt };
