'use strict';
/**
 * Server only. Offline RS256 verification of OpenVibe.Network tokens against the Network JWKS. No
 * JWT library: the rules are the ones written here.
 *
 *   verifyUserToken(token, { jwks })   a person's SSO access token (sub, id, subject_id, username, role, …)
 *   verifyAppToken(token, { jwks, audience, acceptSandbox })
 *                                      a developer app's token (identity.service-token-claims@1:
 *                                      sub app:app_…, actor_type app, cap, project_id, env, on_behalf_of?)
 *
 *   const claims = await verifyUserToken(token, { jwks: 'https://openvibe.network/api/.well-known/jwks' });
 *   claims.subject_id  // usr_… (canonical subject; absent on very old tokens)
 *
 * `jwks` is the JWKS document ({ keys: [...] }, Network's shape also carries public_key PEM), a URL
 * to fetch it from (cached), or pass `publicKey` (PEM or KeyObject). Throws OpenVibeError (401)
 * with a stable code: token.malformed | token.bad_signature | token.expired | token.not_yet_valid |
 * token.wrong_issuer | token.wrong_audience | token.not_user | token.not_app | token.invalid_claims |
 * token.sandbox_refused | token.no_key.
 */
const crypto = require('node:crypto');
const { OpenVibeError } = require('../core/errors');

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const jwksCache = new Map();     // url -> { at, keys: KeyObject-with-kid[] , inflight }

function fail(code, detail, kind = 'user') {
    return new OpenVibeError({ code, status: 401, detail, message: `${kind} token rejected: ${detail}` });
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

/** Signature, time and issuer/audience checks shared by both verifiers; returns the claims. */
async function verifyJwt(token, { jwks, publicKey, issuer, audience, clockSkewSec = 30, now = Date.now(), fetch: fetchImpl = globalThis.fetch } = {}, kind) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || !parts[2]) throw fail('token.malformed', 'not a signed JWT', kind);
    let header, claims;
    try { header = JSON.parse(fromB64url(parts[0])); claims = JSON.parse(fromB64url(parts[1])); } catch { throw fail('token.malformed', 'undecodable', kind); }
    if (!header || header.alg !== 'RS256') throw fail('token.malformed', `alg ${header && header.alg} not accepted`, kind);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw fail('token.malformed', 'claims are not an object', kind);

    let keys;
    if (publicKey) keys = [{ kid: null, key: typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey }];
    else if (typeof jwks === 'string') keys = await loadJwks(jwks, fetchImpl, false);
    else keys = keysFromJwks(jwks);
    if (!keys.length) throw fail('token.no_key', 'no RS256 verification key', kind);

    const input = `${parts[0]}.${parts[1]}`;
    const sig = fromB64url(parts[2]);
    let good = verifyWith(keys, header, input, sig);
    if (!good && typeof jwks === 'string' && header.kid && !keys.some((k) => k.kid === header.kid)) {
        good = verifyWith(await loadJwks(jwks, fetchImpl, true), header, input, sig);   // key rotation
    }
    if (!good) throw fail('token.bad_signature', 'signature does not verify', kind);

    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec < t) throw fail('token.expired', 'expired', kind);
    if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > t) throw fail('token.not_yet_valid', 'not valid yet', kind);
    if (typeof claims.iat === 'number' && claims.iat - clockSkewSec > t) throw fail('token.not_yet_valid', 'issued in the future', kind);
    if (issuer && claims.iss !== issuer) throw fail('token.wrong_issuer', `issuer ${claims.iss}`, kind);
    if (audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud != null ? [claims.aud] : [];
        const want = Array.isArray(audience) ? audience : [audience];
        if (!want.some((a) => aud.includes(a))) throw fail('token.wrong_audience', `not for ${want.join(', ')}`, kind);
    }
    return claims;
}

async function verifyUserToken(token, opts = {}) {
    const claims = await verifyJwt(token, opts, 'user');
    const principal = ['service', 'app', 'mod'].includes(claims.actor_type) || /^(svc|app|mod):/.test(String(claims.sub || ''));
    if (principal && !opts.allowServiceTokens) throw fail('token.not_user', 'a service principal token is not a user token');
    return claims;
}

const APP_SUB_RE = /^app:app_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * verifyAppToken(token, { jwks | publicKey, issuer, audience, acceptSandbox = false })
 *   -> claims { sub: 'app:app_…', actor_type: 'app', aud, cap, ns, project_id, env, on_behalf_of?, iat, exp, jti }
 *
 * A developer app's token (Network developer projects, ADR-014), checked the way openvibe-contracts
 * v0.26 verifyServiceToken() checks it: RS256 signature, expiry, issuer, the ONE audience you
 * serve (required), the claim shape, and env. `env: sandbox` is refused with
 * token.sandbox_refused unless you pass acceptSandbox: true, which you should only do when your
 * service keeps sandbox traffic apart from real data. `on_behalf_of` (usr_…) is present only on
 * tokens from the authorization-code flow: it names the person who authorized the app.
 * Capabilities are not checked here: test `claims.cap` for the one your route performs.
 */
async function verifyAppToken(token, opts = {}) {
    if (!opts.audience) throw new TypeError('verifyAppToken: pass the audience your service answers for (openvibe.<service>)');
    const claims = await verifyJwt(token, opts, 'app');
    if (claims.actor_type !== 'app' || !/^app:/.test(String(claims.sub || ''))) throw fail('token.not_app', 'not a developer app token', 'app');
    const bad = [];
    if (!APP_SUB_RE.test(String(claims.sub))) bad.push('sub');
    if (!Array.isArray(claims.aud) || !claims.aud.length) bad.push('aud');
    if (!Array.isArray(claims.cap) || !claims.cap.every((c) => typeof c === 'string')) bad.push('cap');
    if (claims.ns !== undefined && (!Array.isArray(claims.ns) || !claims.ns.every((n) => typeof n === 'string'))) bad.push('ns');
    if (typeof claims.jti !== 'string' || !claims.jti) bad.push('jti');
    if (!PROJECT_RE.test(String(claims.project_id || ''))) bad.push('project_id');
    if (claims.env !== 'sandbox' && claims.env !== 'production') bad.push('env');
    if (claims.on_behalf_of !== undefined && !USER_RE.test(String(claims.on_behalf_of))) bad.push('on_behalf_of');
    if (bad.length) throw fail('token.invalid_claims', `bad or missing claims: ${bad.join(', ')}`, 'app');
    if (claims.env === 'sandbox' && !opts.acceptSandbox) throw fail('token.sandbox_refused', 'sandbox tokens are not accepted here', 'app');
    return claims;
}

module.exports = { verifyUserToken, verifyAppToken, keysFromJwks, _jwksCache: jwksCache };
