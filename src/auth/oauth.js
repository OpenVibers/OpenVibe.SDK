'use strict';
/**
 * Server only. The half of the authorization-code flow that runs on your server: exchanging the
 * code the browser brought back (with its PKCE verifier), and refreshing first-party user tokens.
 *
 *   POST <network>/oauth/token grant_type=authorization_code, code, redirect_uri, client_id,
 *        [client_secret], code_verifier, [audience], [scope]
 *
 * First-party client (confidential, no audience)
 *   -> { access_token, refresh_token, token_type, expires_in, scope, user, preferences }
 * Developer app (`app_<ULID>`; audience required; PKCE required; confidential apps also send their
 * secret, public apps send none)
 *   -> { access_token, token_type, expires_in: 300, scope }   (no refresh token: sign in again)
 * The app token names the person in `on_behalf_of`; verify it with verifyAppToken().
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

/**
 * exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret?, audience?, scope? })
 * A public client (no clientSecret) must send the PKCE codeVerifier; so must every developer app.
 * `scope` (capability ids) may narrow what the person authorized, never widen it. The response is
 * returned as the token endpoint sent it: `refresh_token` is absent for app tokens.
 */
async function exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret, audience, scope, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, ...rest } = {}) {
    if (!code || !redirectUri || !clientId) throw new TypeError('exchangeCode: code, redirectUri and clientId are required');
    if (!clientSecret && !codeVerifier) throw new TypeError('exchangeCode: a public client (no clientSecret) must send its PKCE codeVerifier');
    if (/^app_/.test(String(clientId)) && !codeVerifier) throw new TypeError('exchangeCode: developer apps always use PKCE; pass codeVerifier');
    if (/^app_/.test(String(clientId)) && !audience) throw new TypeError('exchangeCode: developer apps must name the audience (openvibe.<service>) the token is for');
    return postToken(tokenUrlOf(rest), {
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret || undefined,
        code_verifier: codeVerifier, audience: audience || undefined, scope: Array.isArray(scope) ? scope.join(' ') || undefined : scope || undefined,
    }, fetchImpl, timeoutMs);
}

async function refreshUserToken({ refreshToken, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, ...rest } = {}) {
    if (!refreshToken || !clientId || !clientSecret) throw new TypeError('refreshUserToken: refreshToken, clientId and clientSecret are required');
    return postToken(tokenUrlOf(rest), { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }, fetchImpl, timeoutMs);
}

module.exports = { exchangeCode, refreshUserToken };
