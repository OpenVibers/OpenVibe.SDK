'use strict';
/**
 * Server only. The half of the authorization-code flow that needs the client's credentials:
 * exchanging the code the browser brought back (with its PKCE verifier) and refreshing.
 *
 *   POST <network>/oauth/token grant_type=authorization_code, code, redirect_uri, client_id,
 *        client_secret, code_verifier
 *   -> { access_token, refresh_token, token_type, expires_in, scope, user, preferences }
 */
const { OpenVibeError } = require('../core/errors');
const { DEFAULT_NETWORK } = require('../core/client');

async function postToken(url, params, fetchImpl, timeoutMs) {
    let res;
    try {
        res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString(),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new OpenVibeError({ code: err && err.name === 'TimeoutError' ? 'sdk.timeout' : 'sdk.network_error', message: `token endpoint unreachable: ${err && err.message}`, cause: err, method: 'POST', url });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.access_token) throw OpenVibeError.fromResponse({ status: res.status, body: json, method: 'POST', url });
    return json;
}

function tokenUrlOf({ tokenUrl, network = DEFAULT_NETWORK }) {
    return tokenUrl || `${String(network).replace(/\/+$/, '')}/oauth/token`;
}

async function exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, ...rest } = {}) {
    if (!code || !redirectUri || !clientId || !clientSecret) throw new TypeError('exchangeCode: code, redirectUri, clientId and clientSecret are required');
    return postToken(tokenUrlOf(rest), {
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: codeVerifier,
    }, fetchImpl, timeoutMs);
}

async function refreshUserToken({ refreshToken, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, ...rest } = {}) {
    if (!refreshToken || !clientId || !clientSecret) throw new TypeError('refreshUserToken: refreshToken, clientId and clientSecret are required');
    return postToken(tokenUrlOf(rest), { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }, fetchImpl, timeoutMs);
}

module.exports = { exchangeCode, refreshUserToken };
