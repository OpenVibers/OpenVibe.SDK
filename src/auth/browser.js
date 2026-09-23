'use strict';
/**
 * openvibe-sdk/auth, browser entry: OAuth2 authorization code + PKCE (RFC 7636, S256).
 *
 * The browser builds the authorize URL and keeps the verifier (sessionStorage, or your server's
 * session). The code is then exchanged on your server (openvibe-sdk/auth server entry,
 * exchangeCode()): a confidential client's credentials never reach a browser, and even a public
 * developer app (no secret) is best served by keeping the token in an HttpOnly server session.
 * This file holds no credentials and uses Web Crypto only.
 *
 * Two kinds of client use this flow:
 *   first-party sign-in   scope 'profile theme' (the default); the exchange yields a user token
 *   developer app         `audience` (openvibe.<service>) and `scope` = capability ids; the exchange
 *                         yields a 5-minute app token acting for the person (no refresh token)
 */
const { OpenVibeError } = require('../core/errors');
const { randomBytes } = require('../core/ids');
const { DEFAULT_NETWORK } = require('../core/client');

function base64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A random code verifier: 43..128 characters of [A-Za-z0-9-._~] (default 64). */
function createCodeVerifier(length = 64) {
    if (!Number.isInteger(length) || length < 43 || length > 128) throw new RangeError('PKCE verifier length must be 43..128');
    return base64url(randomBytes(Math.ceil(length * 3 / 4))).slice(0, length);
}

/** S256 challenge: BASE64URL(SHA-256(ASCII(verifier))). */
async function pkceChallenge(verifier) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('openvibe-sdk: Web Crypto subtle digest is required for PKCE');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(verifier)));
    return base64url(new Uint8Array(digest));
}

/** { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' } */
async function createPkcePair(length) {
    const codeVerifier = createCodeVerifier(length);
    return { codeVerifier, codeChallenge: await pkceChallenge(codeVerifier), codeChallengeMethod: 'S256' };
}

/** An unguessable `state` value that ties the callback to this browser. */
function createState() {
    return base64url(randomBytes(24));
}

/**
 * GET <network>/oauth/authorize?response_type=code&client_id&redirect_uri&scope&state
 *     &code_challenge&code_challenge_method=S256[&audience][&prompt=none]
 *
 * `scope` defaults to 'profile theme' (first-party sign-in) only when no `audience` is given. A
 * developer app passes `audience` and its capability ids as `scope`; without a scope the code may
 * yield every capability the app holds for that audience. Network refuses prompt=none for apps
 * (error=interaction_required): a person always chooses to continue.
 */
function buildAuthorizeUrl({ network = DEFAULT_NETWORK, authorizeUrl, clientId, redirectUri, scope, audience, state, codeChallenge, codeChallengeMethod = 'S256', prompt } = {}) {
    if (!clientId || !redirectUri) throw new TypeError('clientId and redirectUri are required');
    const u = new URL(authorizeUrl || `${String(network).replace(/\/+$/, '')}/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    const s = scope === undefined && !audience ? 'profile theme' : scope;
    const scopeText = Array.isArray(s) ? s.filter(Boolean).join(' ') : s;
    if (scopeText) u.searchParams.set('scope', scopeText);
    if (audience) u.searchParams.set('audience', audience);
    if (state) u.searchParams.set('state', state);
    if (codeChallenge) {
        u.searchParams.set('code_challenge', codeChallenge);
        u.searchParams.set('code_challenge_method', codeChallengeMethod);
    }
    if (prompt) u.searchParams.set('prompt', prompt);
    return u.toString();
}

/**
 * Everything a sign-in button needs: { url, state, codeVerifier, codeChallenge }.
 * Store `state` and `codeVerifier` until the callback, then send the code and verifier to your server.
 * A developer app passes { audience, scope: [capability ids] } and exchanges with the same audience.
 */
async function startAuthorization(opts = {}) {
    const pair = await createPkcePair(opts.verifierLength);
    const state = opts.state || createState();
    const url = buildAuthorizeUrl({ ...opts, state, codeChallenge: pair.codeChallenge, codeChallengeMethod: 'S256' });
    return { url, state, codeVerifier: pair.codeVerifier, codeChallenge: pair.codeChallenge };
}

/**
 * Read the redirect back from the Network: { code, state } or throws OpenVibeError
 * (oauth.<error> such as oauth.login_required after prompt=none, or oauth.state_mismatch).
 */
function readCallback(location, { expectedState } = {}) {
    const u = new URL(String(location), 'http://localhost');
    const p = u.searchParams;
    const state = p.get('state') || '';
    if (p.get('error')) {
        throw new OpenVibeError({ code: `oauth.${p.get('error')}`, status: 400, detail: p.get('error_description') || p.get('error'), message: `authorization failed: ${p.get('error')}` });
    }
    if (expectedState !== undefined && state !== expectedState) {
        throw new OpenVibeError({ code: 'oauth.state_mismatch', status: 400, message: 'the callback state does not match the one this browser started with' });
    }
    const code = p.get('code');
    if (!code) throw new OpenVibeError({ code: 'oauth.missing_code', status: 400, message: 'the callback carries no authorization code' });
    return { code, state };
}

/**
 * The header and claims of a JWT, decoded WITHOUT checking its signature, issuer, audience or
 * expiry: { header, claims } or null when it is not a JWT. For display and logging only (who a
 * token names, what it may do, when it expires). Never authorize anything with it: a receiver
 * verifies tokens with verifyUserToken() / verifyAppToken() (server).
 */
function decodeUnverified(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return null;
    try {
        const part = (p) => {
            const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
            const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
            return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
        };
        const header = part(parts[0]);
        const claims = part(parts[1]);
        if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
        return { header, claims };
    } catch {
        return null;
    }
}

/** decodeUnverified(token).claims, or null. UNVERIFIED: see decodeUnverified(). */
function unverifiedClaims(token) {
    const d = decodeUnverified(token);
    return d ? d.claims : null;
}

module.exports = { createCodeVerifier, pkceChallenge, createPkcePair, createState, buildAuthorizeUrl, startAuthorization, readCallback, base64url, decodeUnverified, unverifiedClaims };
