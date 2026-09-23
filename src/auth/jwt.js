'use strict';
/**
 * Server only. Offline RS256 verification of an OpenVibe.Network user token (the SSO access token:
 * sub, id, subject_id, username, role, …) against the Network JWKS. No JWT library: the rules
 * are the ones written here.
 *
 *   const claims = await verifyUserToken(token, { jwks: 'https://openvibe.network/api/.well-known/jwks' });
 *   claims.subject_id  // usr_… (canonical subject; absent on very old tokens)
 *
 * `jwks` is the JWKS document ({ keys: [...] }, Network's shape also carries public_key PEM), a URL
 * to fetch it from (cached), or pass `publicKey` (PEM or KeyObject). Throws OpenVibeError (401)
 * with a stable code: token.malformed | token.bad_signature | token.expired | token.not_yet_valid |
 * token.wrong_issuer | token.wrong_audience | token.not_user | token.no_key.
 */
const crypto = require('node:crypto');
const { OpenVibeError } = require('../core/errors');

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const jwksCache = new Map();     // url -> { at, keys: KeyObject-with-kid[] , inflight }

function fail(code, detail) {
    return new OpenVibeError({ code, status: 401, detail, message: `user token rejected: ${detail}` });
}

function keysFromJwks(doc) {
    const out = [];
    if (!doc || typeof doc !== 'object') return out;
    for (const jwk of Array.isArray(doc.keys) ? doc.keys : []) {
        if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
        try { out.push({ kid: jwk.kid || null, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) }); } catch { /* skip unusable key */ }
    }
    if (typeof doc.public_key === 'string' && doc.public_key.includes('BEGIN')) {
        try { out.push({ kid: null, key: crypto.createPublicKey(doc.public_key) }); } catch { /* skip */ }
    }
    return out;
}

async function loadJwks(url, fetchImpl, force) {
    const hit = jwksCache.get(url);
    if (hit && hit.keys && !force && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
    if (hit && hit.inflight) return hit.inflight;
    const entry = hit || {};
    entry.inflight = (async () => {
        const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new OpenVibeError({ code: 'token.no_key', status: 503, message: `JWKS ${url} answered ${res.status}` });
        const keys = keysFromJwks(await res.json());
        Object.assign(entry, { at: Date.now(), keys });
        return keys;
    })().finally(() => { entry.inflight = null; });
    jwksCache.set(url, entry);
    return entry.inflight;
}

function verifyWith(keys, header, input, sig) {
    const byKid = header.kid ? keys.filter((k) => k.kid === header.kid) : [];
    const candidates = byKid.length ? byKid : keys;
    return candidates.some(({ key }) => {
        try { return crypto.verify('RSA-SHA256', Buffer.from(input), key, sig); } catch { return false; }
    });
}

async function verifyUserToken(token, { jwks, publicKey, issuer, audience, clockSkewSec = 30, now = Date.now(), fetch: fetchImpl = globalThis.fetch, allowServiceTokens = false } = {}) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || !parts[2]) throw fail('token.malformed', 'not a signed JWT');
    let header, claims;
    try { header = JSON.parse(fromB64url(parts[0])); claims = JSON.parse(fromB64url(parts[1])); } catch { throw fail('token.malformed', 'undecodable'); }
    if (!header || header.alg !== 'RS256') throw fail('token.malformed', `alg ${header && header.alg} not accepted`);
    if (!claims || typeof claims !== 'object') throw fail('token.malformed', 'claims are not an object');

    let keys;
    if (publicKey) keys = [{ kid: null, key: typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey }];
    else if (typeof jwks === 'string') keys = await loadJwks(jwks, fetchImpl, false);
    else keys = keysFromJwks(jwks);
    if (!keys.length) throw fail('token.no_key', 'no RS256 verification key');

    const input = `${parts[0]}.${parts[1]}`;
    const sig = fromB64url(parts[2]);
    let good = verifyWith(keys, header, input, sig);
    if (!good && typeof jwks === 'string' && header.kid && !keys.some((k) => k.kid === header.kid)) {
        good = verifyWith(await loadJwks(jwks, fetchImpl, true), header, input, sig);   // key rotation
    }
    if (!good) throw fail('token.bad_signature', 'signature does not verify');

    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec < t) throw fail('token.expired', 'expired');
    if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > t) throw fail('token.not_yet_valid', 'not valid yet');
    if (typeof claims.iat === 'number' && claims.iat - clockSkewSec > t) throw fail('token.not_yet_valid', 'issued in the future');
    if (issuer && claims.iss !== issuer) throw fail('token.wrong_issuer', `issuer ${claims.iss}`);
    if (audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud != null ? [claims.aud] : [];
        const want = Array.isArray(audience) ? audience : [audience];
        if (!want.some((a) => aud.includes(a))) throw fail('token.wrong_audience', `not for ${want.join(', ')}`);
    }
    const principal = ['service', 'app', 'mod'].includes(claims.actor_type) || /^(svc|app|mod):/.test(String(claims.sub || ''));
    if (principal && !allowServiceTokens) throw fail('token.not_user', 'a service principal token is not a user token');
    return claims;
}

module.exports = { verifyUserToken, keysFromJwks, _jwksCache: jwksCache };
