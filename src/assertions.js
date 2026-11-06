'use strict';
/**
 * openvibe-sdk/assertions: subject assertions (ADR-003, amendment 2026-11-06; plan H1).
 *
 *
 * A subject assertion is a short-lived, Network-signed proof that a person authorized the calling
 * service to act for them on ONE other service (the audience). It is what a money call carries
 * beside the name of the person:
 *
 *   Authorization: Bearer <the service's own token>      who is calling
 *   X-OV-Subject: usr_…                                   who the service says it acts for
 *   X-OV-Subject-Assertion: <the assertion>                that the person allowed it
 *
 * Without the assertion, ADR-003's rule holds: the service vouches for its own signed-in person,
 * so any first-party service that knows a person's id could act for them. With it, the receiver
 * checks a signature from Network instead of the service's word.
 *
 * The two halves:
 *
 *   requestSubjectAssertion({ userToken, audience, … })   the caller: ask Network to sign the
 *       person's own access token into an assertion for `audience`. The person's token is the
 *       only thing that can produce one: without it Network answers 401.
 *   verifySubjectAssertion(assertion, { jwks, audience, … })   the receiver (Billing, Tips):
 *       check the ES256 signature against Network's JWKS, the audience, the expiry and the jti
 *       replay window.
 *
 * The assertion lives 60 seconds and names the service it was minted for (`act`), so it cannot be
 * carried to another service, and a replayed one is refused.
 */
const crypto = require('node:crypto');
const { OpenVibeError } = require('./core/errors');
const { jwksClient, keysFromJwks } = require('./auth/jwks');

/** The header a money call carries the assertion in. */
const ASSERTION_HEADER = 'x-ov-subject-assertion';
/** How long an assertion lives. */
const ASSERTION_TTL_S = 60;
/** The default replay window: a jti is remembered this long after it was seen. */
const REPLAY_WINDOW_MS = 2 * 60 * 1000;
/** How much clock difference is forgiven. An assertion lives 60 s, so this stays small. */
const CLOCK_SKEW_SEC = 10;

const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SERVICE_RE = /^svc:[a-z][a-z0-9-]{1,39}$/;

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The ES256 keys of a JWKS document (the assertion key is EC, the session key is RSA). */
function ecKeysFromJwks(doc) { return keysFromJwks(doc, { kty: 'EC' }); }

/** The JWKS client that keeps only the EC (ES256) keys (one per URL, shared by the process). */
function ecJwksClient(url, opts = {}) { return jwksClient(url, { ...opts, kty: 'EC' }); }

/**
 * Ask Network to sign the person's own access token into an assertion for `audience`.
 *
 *   const out = await requestSubjectAssertion({
 *       userToken: req.token,                 // the person's Network access token (their session)
 *       audience: 'openvibe.billing',         // the service the assertion is for
 *       token: await tokens.getToken(),       // the caller's own service token (Bearer)
 *       internalUrl: 'http://127.0.0.1:4000', // where Network's /internal is (loopback on the same host)
 *   });
 *   // → { assertion, subject, audience, jti, expires_at, expires_in }
 *
 * `tokenClient` may be given instead of `token` (the SDK's createServiceTokenClient, or anything
 * with getToken()). The person's token is never optional: Network refuses to sign without it.
 *
 * `audience` may be a list, when the assertion travels a chain: a tip goes from the site (Live) to
 * Tips and on to Billing, so the assertion names both money services. `for` names the services that
 * may carry it (the minting service is always in it); the receiver refuses an assertion presented by
 * a service that is not.
 */
async function requestSubjectAssertion({
    userToken, audience, for: forServices, network, internalUrl, url, token, tokenClient, subject,
    fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, log = null,
} = {}) {
    if (!userToken) throw new TypeError('requestSubjectAssertion: the person\'s own access token is required');
    if (!audience) throw new TypeError('requestSubjectAssertion: pass the audience the assertion is for (openvibe.<service>)');
    const endpoint = url || `${String(internalUrl || network || '').replace(/\/+$/, '')}/internal/subject-assertions`;
    if (!/^https?:\/\//.test(endpoint)) throw new TypeError('requestSubjectAssertion: pass where Network lives (network or internalUrl)');
    let bearer = token;
    if (!bearer && tokenClient) bearer = await tokenClient.getToken();
    if (!bearer) throw new TypeError('requestSubjectAssertion: pass the caller\'s own service token (token or tokenClient)');

    const body = { user_token: String(userToken), audience: Array.isArray(audience) ? audience.map(String) : String(audience) };
    if (forServices) body.for = (Array.isArray(forServices) ? forServices : [forServices]).map(String);
    if (subject) body.subject = String(subject);

    let res;
    try {
        res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new OpenVibeError({ code: 'assertion.network_error', status: 503, retryable: true, message: `Network did not answer: ${err && err.message}`, cause: err, method: 'POST', url: endpoint });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.assertion) {
        const problem = json || {};
        throw OpenVibeError.fromResponse({
            status: res.status,
            body: { error: problem.code || problem.error || 'assertion.refused', error_description: problem.detail || problem.error_description || 'no assertion in the response' },
            method: 'POST', url: endpoint,
        });
    }
    return {
        assertion: json.assertion,
        subject: json.subject || null,
        audience: json.audience || (Array.isArray(audience) ? audience : String(audience)),
        jti: json.jti || null,
        expires_at: json.expires_at || null,
        expires_in: Number(json.expires_in) || ASSERTION_TTL_S,
    };
}

/** The header a money call carries the assertion in: { 'x-ov-subject-assertion': assertion }. */
function subjectAssertionHeader(assertion) { return { [ASSERTION_HEADER]: String(assertion || '') }; }

/** The ES256 signature check (raw r||s, as JWT ES256 signs it). */
function verifyEs256(keys, header, input, sig) {
    const byKid = header.kid ? keys.filter((k) => k.kid === header.kid) : [];
    const candidates = byKid.length ? byKid : keys;
    return candidates.some(({ key }) => {
        try { return crypto.verify('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }, sig); } catch { return false; }
    });
}

/**
 * Check a subject assertion.
 *
 *   const r = await verifySubjectAssertion(assertion, { jwks: 'https://openvibe.network/api/.well-known/jwks', audience: 'openvibe.billing' });
 *   if (!r.ok) return problem(res, 403, r.code, { detail: r.reason });
 *   req.subject = { subject: r.claims.sub, act: r.claims.act, jti: r.claims.jti };
 *
 * `caller` is the service presenting the assertion (svc:live). The assertion names the service
 * that vouched for the person (`act`) and the services that may carry it (`for`, the minting
 * service alone by default): an assertion presented by a service that is not in `for` is refused.
 * `seen` is a Map or Set of jtis already used: an assertion whose jti is in it is a replay and is
 * refused.
 *
 * Returns { ok: true, claims } or { ok: false, code, reason } with a stable code:
 * assertion.malformed | assertion.bad_signature | assertion.expired | assertion.not_yet_valid |
 * assertion.wrong_issuer | assertion.wrong_audience | assertion.invalid_claims |
 * assertion.actor_mismatch | assertion.replayed | assertion.no_key.
 */
async function verifySubjectAssertion(assertion, {
    jwks, publicKey, audience, issuer, caller, now = Date.now(), clockSkewSec = CLOCK_SKEW_SEC, seen = null, log = null,
} = {}) {
    const fail = (code, reason) => ({ ok: false, code, reason });
    const parts = typeof assertion === 'string' ? assertion.split('.') : [];
    if (parts.length !== 3 || !parts[2]) return fail('assertion.malformed', 'not a signed JWT');
    let header, claims;
    try { header = JSON.parse(fromB64url(parts[0])); claims = JSON.parse(fromB64url(parts[1])); } catch { return fail('assertion.malformed', 'undecodable'); }
    if (!header || header.alg !== 'ES256') return fail('assertion.malformed', `alg ${header && header.alg} not accepted`);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return fail('assertion.malformed', 'the claims are not an object');

    let keys;
    try {
        if (publicKey) keys = [{ kid: header.kid || null, key: typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey }];
        else if (typeof jwks === 'string') keys = await ecJwksClient(jwks, { log }).keysForKid(header.kid);
        else if (jwks && typeof jwks.keysForKid === 'function') keys = await jwks.keysForKid(header.kid);
        else keys = ecKeysFromJwks(jwks);
    } catch (err) {
        try { (log && (log.warn || log.error) || (() => {})).call(log, `[openvibe-sdk] subject assertion not verified: ${(err && err.message) || err}`); } catch { /* never throw from logging */ }
        return fail('assertion.no_key', 'the signing key is not loaded yet');
    }
    if (!keys.length) return fail('assertion.no_key', 'no ES256 verification key');

    if (!verifyEs256(keys, header, `${parts[0]}.${parts[1]}`, fromB64url(parts[2]))) return fail('assertion.bad_signature', 'the signature does not verify');

    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec < t) return fail('assertion.expired', 'the assertion has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > t) return fail('assertion.not_yet_valid', 'not valid yet');
    if (typeof claims.iat !== 'number' || claims.iat - clockSkewSec > t) return fail('assertion.not_yet_valid', 'issued in the future');
    if (issuer && claims.iss !== issuer) return fail('assertion.wrong_issuer', `issuer ${claims.iss}`);
    if (audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud != null ? [claims.aud] : [];
        const want = Array.isArray(audience) ? audience : [audience];
        if (!want.some((a) => aud.includes(a))) return fail('assertion.wrong_audience', `not for ${want.join(', ')}`);
    }
    if (!USER_RE.test(String(claims.sub || ''))) return fail('assertion.invalid_claims', 'it names no person');
    if (claims.act !== undefined && !SERVICE_RE.test(String(claims.act))) return fail('assertion.invalid_claims', 'it names no service');
    if (claims.for !== undefined && (!Array.isArray(claims.for) || !claims.for.every((f) => SERVICE_RE.test(String(f))))) {
        return fail('assertion.invalid_claims', 'it names no service that may carry it');
    }
    if (caller) {
        // The services that may carry the assertion: the `for` list, or the minting service alone.
        const may = Array.isArray(claims.for) && claims.for.length ? claims.for.map(String) : [String(claims.act || '')];
        if (!may.includes(String(caller))) return fail('assertion.actor_mismatch', `it may not be carried by ${caller}`);
    }
    if (typeof claims.jti !== 'string' || !claims.jti) return fail('assertion.invalid_claims', 'it has no jti');
    if (seen) {
        if (seen instanceof Set) { if (seen.has(claims.jti)) return fail('assertion.replayed', 'this assertion was already used'); }
        else if (seen instanceof Map) { if (seen.has(claims.jti)) return fail('assertion.replayed', 'this assertion was already used'); }
        else if (typeof seen.has === 'function' && seen.has(claims.jti)) return fail('assertion.replayed', 'this assertion was already used');
    }
    return { ok: true, claims };
}

/**
 * A verifier that remembers the jtis it has seen, so a replayed assertion is refused inside the
 * replay window. One per service process:
 *
 *   const verifier = createSubjectAssertionVerifier({ jwks, audience: 'openvibe.billing' });
 *   const r = await verifier.verify(assertion, { act: 'svc:live' });
 */
function createSubjectAssertionVerifier({ jwks, audience, issuer, clockSkewSec = CLOCK_SKEW_SEC, replayWindowMs = REPLAY_WINDOW_MS, now = () => Date.now(), log = null } = {}) {
    const seen = new Map();       // jti -> the time it was seen
    function prune() {
        const t = now();
        for (const [jti, at] of seen) if (t - at > replayWindowMs) seen.delete(jti);
    }
    return {
        async verify(assertion, opts = {}) {
            const r = await verifySubjectAssertion(assertion, { jwks, audience, issuer, clockSkewSec, log, ...opts });
            if (!r.ok) return r;
            prune();
            const jti = r.claims.jti;
            if (seen.has(jti)) return { ok: false, code: 'assertion.replayed', reason: 'this assertion was already used' };
            seen.set(jti, now());
            return r;
        },
        /** How many jtis are remembered (for /api/ready and tests). */
        size() { prune(); return seen.size; },
        seen,
    };
}

module.exports = { requestSubjectAssertion, verifySubjectAssertion, createSubjectAssertionVerifier, subjectAssertionHeader, ASSERTION_HEADER, ASSERTION_TTL_S, REPLAY_WINDOW_MS, CLOCK_SKEW_SEC };
