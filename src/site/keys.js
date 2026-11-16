'use strict';
/**
 * The Network's RS256 signing key for a site: fetched from GET /api/.well-known/jwks on the configured internal URL and
 * kept fresh by openvibe-sdk/auth's JWKS client. Tokens are verified offline against it: the person's session token
 * (sign-in) and a person's Bearer token (the API).
 *
 * This was server/auth/keys.js, copied into 31 sites (the consolidation review of 2026-11-16); 29 copies were this
 * code with the site's name in the log lines. keys.get() / keys.ensure() / keys.loaded() serve readiness and the SSO
 * middleware. Nothing the SDK says about a failed key fetch leaves this module: token.no_key answers 'signing key not
 * loaded yet'.
 *
 *   const keys = createKeyStore({ config, name: 'OpenVibe.Blog' });
 *   const r = await keys.verifyUser(token, { issuer, audience });   // { ok, claims } | { ok: false, reason, code, expired }
 */
const auth = require('../auth');

const KEY_UNAVAILABLE = 'signing key not loaded yet';
const DOES_NOT_VERIFY = 'token does not verify';

/** What a person may be told about a rejected token: never the key fetch's own error. */
function publicReason(err) {
    const code = err && err.code;
    if (!code || code === 'token.no_key') return code ? KEY_UNAVAILABLE : DOES_NOT_VERIFY;
    return (err.message && String(err.message).slice(0, 200)) || DOES_NOT_VERIFY;
}

/** The JWKS address from a site's config: the flat shape (networkInternalUrl / networkUrl) or the nested one (network.internalUrl / network.url). */
function jwksUrl(config) {
    const c = config || {};
    const n = c.network && typeof c.network === 'object' ? c.network : {};
    const base = c.networkInternalUrl || c.networkUrl || n.internalUrl || n.url;
    if (!base) throw new TypeError('jwksUrl: the config names no Network URL (networkInternalUrl, networkUrl or network.url)');
    return String(base).replace(/\/+$/, '') + '/api/.well-known/jwks';
}

/**
 * { config, name = 'site', fetchImpl = fetch, log = console } → { ensure, get, loaded, status, verifyUser, verifyApp,
 * pemForToken, client }. `name` is the log prefix ('OpenVibe.Blog').
 */
function createKeyStore({ config, name = 'site', fetchImpl = globalThis.fetch, log = console } = {}) {
    const url = jwksUrl(config);
    const client = auth.jwksClient(url, { fetch: fetchImpl, log });
    const tag = `[${name}]`;
    let mirror = null;

    async function refreshMirror() {
        try {
            const ks = await client.keys();
            const first = ks && ks[0];
            mirror = first ? { pem: first.key.export({ type: 'spki', format: 'pem' }), count: ks.length } : null;
        } catch (err) { log.warn(`${tag} JWKS mirror refresh failed: ${(err && err.message) || err}`); mirror = null; }
    }
    async function ensure() { await refreshMirror(); }
    function get() { return mirror ? mirror.pem : null; }
    function loaded() { return Boolean(mirror); }

    const asMs = (v) => (typeof v === 'function' ? v() : (typeof v === 'number' ? v : Date.now()));

    async function verifyUser(token, { issuer, audience, now = Date.now() } = {}) {
        try {
            const claims = await auth.verifyUserToken(token, { jwks: url, issuer, audience, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`${tag} user token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code, expired: code === 'token.expired' };
        }
    }

    async function verifyApp(token, { issuer, audience, acceptSandbox = true, now = Date.now() } = {}) {
        try {
            const claims = await auth.verifyAppToken(token, { jwks: url, issuer, audience, acceptSandbox, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`${tag} app token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code };
        }
    }

    async function pemForToken(token) {
        let kid = null;
        try { kid = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { /* the guard refuses it */ }
        try {
            const ks = await client.keysForKid(kid);
            const k = (kid && ks.find((x) => x.kid === kid)) || ks[0];
            return k ? k.key.export({ type: 'spki', format: 'pem' }) : null;
        } catch { return null; }
    }

    return { ensure, get, loaded, status: client.status, verifyUser, verifyApp, pemForToken, client };
}

module.exports = { createKeyStore, jwksUrl, publicReason, KEY_UNAVAILABLE, DOES_NOT_VERIFY };
