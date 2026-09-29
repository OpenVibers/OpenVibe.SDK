'use strict';
/**
 * verifyServiceToken(token, { jwks (a URL or a JWKS document) | publicKey, issuer, audience, contracts, acceptSandbox, log })
 *   → { ok: true, claims } | { ok: false, code, reason }
 *
 * A Network service or app token (identity.service-token-claims@1), for a service that receives them. The SDK
 * supplies only the KEY: the process-wide JWKS client (./jwks.js: the last good keys through a Network outage,
 * a rotation honoured on an unknown kid, unknown-kid floods throttled) or a pinned PEM. Every token rule is
 * openvibe-contracts' serviceAuth.verifyServiceToken from the service's OWN pinned contracts module, passed in as
 * `contracts` (the SDK carries no copy of the rules, so they cannot drift: the claim schema, issuer, the one
 * audience, expiry, the sandbox refusal).
 *
 * Key choice: the key the token's `kid` names, else every key; the first verdict that is not a bad signature wins.
 * No key at all answers token.unavailable with a fixed reason: the JWKS client's error names the internal JWKS URL
 * and the fetch error, so it goes to `log`, never into the answer (callers answer 503 for token.unavailable).
 */
const { jwksClient, keysFromJwks } = require('./jwks');

function headerKid(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { return null; }
}

async function verifyServiceToken(token, { jwks = null, publicKey = null, issuer, audience, contracts, acceptSandbox = false, log = null, fetch: fetchImpl } = {}) {
    if (!contracts || !contracts.serviceAuth || typeof contracts.serviceAuth.verifyServiceToken !== 'function') {
        throw new TypeError('verifyServiceToken: pass your pinned openvibe-contracts module as `contracts`');
    }
    if (!audience) throw new TypeError('verifyServiceToken: pass the audience your service answers for (openvibe.<service>)');
    const check = (key) => contracts.serviceAuth.verifyServiceToken(token, { publicKey: key, issuer, audience, acceptSandbox });
    if (publicKey) return check(publicKey);
    if (!jwks) throw new TypeError('verifyServiceToken: pass `jwks` (the JWKS URL) or `publicKey`');
    const kid = headerKid(token);
    let keys;
    try {
        keys = typeof jwks === 'string' ? await jwksClient(jwks, { log, ...(fetchImpl ? { fetch: fetchImpl } : {}) }).keysForKid(kid) : keysFromJwks(jwks);
    } catch (err) {
        try { (log && (log.warn || log.error) || (() => {})).call(log, `[openvibe-sdk] service token not verified: ${(err && err.message) || err}`); } catch { /* */ }
        return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
    }
    const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
    let last = { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
    for (const k of byKid.length ? byKid : keys) {
        last = check(k.key);
        if (last.ok || last.code !== 'token.bad_signature') return last;
    }
    return last;
}

module.exports = { verifyServiceToken, headerKid };
