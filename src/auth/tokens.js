'use strict';
/**
 * Server only. Service/app principal tokens from OpenVibe.Network (ADR-003, contract
 * identity.service-token-claims@1):
 *
 *   POST <network>/oauth/token  grant_type=client_credentials, client_id, client_secret, audience[, scope]
 *   -> { access_token, token_type: 'Bearer', expires_in: 300, scope }
 *
 * Same semantics as openvibe-contracts serviceAuth.createTokenClient(), standalone: one cached token
 * per audience (and scope), refreshed 60 s before expiry; concurrent callers share one request.
 * Plug it into createClient({ tokenProvider }) and every call gets a token for the audience of the
 * service it calls (openvibe.media, openvibe.events, …).
 */
const { OpenVibeError } = require('../core/errors');
const { DEFAULT_NETWORK } = require('../core/client');

function createServiceTokenClient({
    network = DEFAULT_NETWORK, tokenUrl, clientId, clientSecret, audience, scope,
    fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, refreshSkewMs = 60000, now = () => Date.now(),
} = {}) {
    if (!clientId || !clientSecret) throw new TypeError('createServiceTokenClient: clientId and clientSecret are required');
    const url = tokenUrl || `${String(network).replace(/\/+$/, '')}/oauth/token`;
    const cache = new Map();      // key -> { token, exp }
    const inflight = new Map();   // key -> Promise<string>

    const scopeFor = (aud, override) => {
        const s = override !== undefined ? override : (scope && typeof scope === 'object' && !Array.isArray(scope) ? scope[aud] : scope);
        return Array.isArray(s) ? s.join(' ') : s || undefined;
    };
    const keyOf = (aud, s) => `${aud}\n${s || ''}`;

    async function fetchToken(aud, s, key) {
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience: aud });
        if (s) body.set('scope', s);
        let res;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: body.toString(),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new OpenVibeError({ code: err && err.name === 'TimeoutError' ? 'sdk.timeout' : 'sdk.network_error', retryable: true, message: `token endpoint unreachable: ${err && err.message}`, cause: err, method: 'POST', url });
        }
        const json = await res.json().catch(() => null);
        if (!res.ok || !json || !json.access_token) {
            throw OpenVibeError.fromResponse({ status: res.status, body: json || { error: 'no_token', error_description: 'no access_token in the response' }, method: 'POST', url });
        }
        cache.set(key, { token: json.access_token, exp: now() + (Number(json.expires_in) || 300) * 1000, scope: json.scope });
        return json.access_token;
    }

    /** getToken({ audience?, scope? }) -> access token for that audience. */
    async function getToken(ctx = {}) {
        const aud = ctx.audience || audience;
        if (!aud) throw new TypeError('getToken: no audience (pass one to createServiceTokenClient or per call)');
        const s = scopeFor(aud, ctx.scope);
        const key = keyOf(aud, s);
        const hit = cache.get(key);
        if (hit && hit.exp - refreshSkewMs > now()) return hit.token;
        if (!inflight.has(key)) inflight.set(key, fetchToken(aud, s, key).finally(() => inflight.delete(key)));
        return inflight.get(key);
    }

    return {
        getToken,
        async authHeaders(ctx) { return { Authorization: `Bearer ${await getToken(ctx)}` }; },
        /** Drop the cached token (one audience, or all): the next call fetches a new one. */
        invalidate(ctx = {}) {
            const aud = ctx.audience || audience;
            if (!aud) { cache.clear(); return; }
            for (const k of [...cache.keys()]) if (k.startsWith(`${aud}\n`)) cache.delete(k);
        },
        tokenUrl: url,
    };
}

module.exports = { createServiceTokenClient };
