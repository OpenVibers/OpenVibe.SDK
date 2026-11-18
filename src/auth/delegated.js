'use strict';
/**
 * Delegated person tokens (0.187.0, 2026-11-18): something the person allowed (an Apps-page key, Codes or Actor acting
 * for them) using that person's account at a few named OpenVibe services, for a few minutes, never as staff.
 *
 * Network mints one per call (Connect's /mcp/all, a first-party app the key holds a grant in); a site accepts one only
 * when it opts in (createSsoClient({ delegated: true }), verifyUserToken(…, { delegated: { service } })) and only when
 * the token names that site. Everywhere else it is a typed token, refused as a session, which is the default.
 *
 *   claims: the person's own (sub, id, subject_id, username, display_name, avatar_url)
 *           typ 'delegated'
 *           svc  ['design', 'ai']            the services that may accept it (the site, and what that site calls as you)
 *           act  { sub: 'ck_…' | 'svc:codes' } who acts for the person (RFC 8693's actor claim)
 *           scope 'read' | 'write'           what the grant allows; the site decides what each means
 *           role 'user', no staff claims      never staff powers, whatever the person's own role is
 *           exp - iat ≤ DELEGATED_MAX_TTL_SEC (15 minutes)
 *
 *   delegatedClaims({ user, by, services, scope, ttlSec, issuer, audience, now }) → claims to sign (RS256, Network's key)
 *   checkDelegated(claims, service, { now }) → the claims a site may use, or throws a token.* error
 *   isDelegated(userOrClaims) → true for a person who arrived through a delegated token
 */
const crypto = require('node:crypto');

const DELEGATED_TYP = 'delegated';
const DELEGATED_MAX_TTL_SEC = 15 * 60;
const SERVICE_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ACTOR_RE = /^[A-Za-z0-9_:.-]{3,120}$/;
// A person's staff powers live in these claims (Network's server/auth/staff-claims.js); a delegated token never has any.
const STAFF_CLAIMS = ['is_owner', 'staff_caps', 'staff_map', 'cap', 'perms', 'permissions'];
const SCOPES = ['read', 'write'];

function delegatedClaims({ user, by, services, scope = 'read', ttlSec = 600, issuer, audience = ['openvibe.network'], now = Date.now() } = {}) {
    if (!user || (user.id == null && !user.subject_id)) throw new TypeError('delegatedClaims: the person (user.id or user.subject_id) is required');
    if (!ACTOR_RE.test(String(by || ''))) throw new TypeError('delegatedClaims: by (who acts for the person) is required');
    const svc = [...new Set((Array.isArray(services) ? services : [services]).map(String))].filter((s) => SERVICE_RE.test(s));
    if (!svc.length) throw new TypeError('delegatedClaims: name at least one service');
    if (!SCOPES.includes(scope)) throw new TypeError('delegatedClaims: scope is read or write');
    const ttl = Math.max(30, Math.min(DELEGATED_MAX_TTL_SEC, Number(ttlSec) || 600));
    const iat = Math.floor(now / 1000);
    return {
        sub: user.id != null ? user.id : user.subject_id,
        id: user.id != null ? user.id : undefined,
        subject_id: user.subject_id || undefined,
        username: user.username || undefined,
        display_name: user.display_name || user.username || undefined,
        avatar_url: user.avatar_url || undefined,
        role: 'user',
        typ: DELEGATED_TYP,
        svc,
        act: { sub: String(by) },
        scope,
        ...(issuer ? { iss: issuer } : {}),
        aud: Array.isArray(audience) ? audience : [audience],
        iat,
        exp: iat + ttl,
        jti: crypto.randomBytes(12).toString('hex'),
    };
}

function fail(code, detail) {
    const err = new Error(`user token rejected: ${detail}`);
    err.code = code;
    err.status = 401;
    err.detail = detail;
    return err;
}

/** A delegated token's claims, checked for SERVICE: named in svc, an actor, a scope, at most 15 minutes, no staff. */
function checkDelegated(claims, service) {
    if (!claims || claims.typ !== DELEGATED_TYP) throw fail('token.not_user', 'not a delegated token');
    if (!SERVICE_RE.test(String(service || ''))) throw fail('token.not_user', 'this site has not said which service it is');
    const svc = Array.isArray(claims.svc) ? claims.svc.map(String) : [];
    if (!svc.includes(service)) throw fail('token.wrong_audience', `a delegated token for ${svc.join(', ') || 'no service'}, not ${service}`);
    if (!claims.act || !ACTOR_RE.test(String(claims.act.sub || ''))) throw fail('token.invalid_claims', 'a delegated token names who acts');
    if (!SCOPES.includes(claims.scope)) throw fail('token.invalid_claims', 'a delegated token has a read or write scope');
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp - claims.iat > DELEGATED_MAX_TTL_SEC) {
        throw fail('token.invalid_claims', 'a delegated token lives at most 15 minutes');
    }
    const out = { ...claims, role: 'user' };
    for (const k of STAFF_CLAIMS) delete out[k];
    out.delegated = { by: String(claims.act.sub), scope: claims.scope, services: svc };
    return out;
}

const isDelegated = (u) => !!(u && (u.typ === DELEGATED_TYP || (u.delegated && typeof u.delegated === 'object')));

module.exports = { delegatedClaims, checkDelegated, isDelegated, DELEGATED_TYP, DELEGATED_MAX_TTL_SEC, STAFF_CLAIMS };
