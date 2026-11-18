'use strict';
/**
 * Delegated person tokens (0.187.0): an Apps-page key or an agent acting for a person, at the services the token names,
 * for at most 15 minutes, never as staff.
 * - Refused as a session everywhere by default (a typed token).
 * - Accepted by verifyUserToken({ delegated: { service } }) only when svc names that service, an actor is named, the
 *   scope is read or write and it lives at most 15 minutes. It comes back as role 'user' with every staff claim gone,
 *   marked `delegated: { by, scope, services }`.
 * - createSsoClient({ delegated: true }) accepts one for the site's own name; requireFullSession refuses it (403).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const { verifyUserToken } = require('../src/auth');
const { delegatedClaims, checkDelegated, isDelegated, DELEGATED_MAX_TTL_SEC } = require('../src/auth/delegated');
const { createSsoClient } = require('../src/sso');

const ISS = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
};
const jwks = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'k1' }] };
const ADA = { id: 7, subject_id: 'usr_01JD8C4QJ7Z3K9W2X5V6N1M0PB', username: 'ada', display_name: 'Ada', role: 'admin' };
const opts = (extra = {}) => ({ jwks, issuer: ISS, audience: ['openvibe.network'], ...extra });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('delegatedClaims: the person, never their role; who acts; the services; at most 15 minutes', () => {
    const c = delegatedClaims({ user: ADA, by: 'ck_01JD8C4QJ7Z3K9W2X5V6N1M0PC', services: ['design', 'ai'], scope: 'write', ttlSec: 99999, issuer: ISS });
    assert.equal(c.typ, 'delegated');
    assert.equal(c.role, 'user', 'an admin\'s token is still only a person\'s');
    assert.deepEqual([c.sub, c.subject_id, c.username, c.svc, c.act, c.scope], [7, ADA.subject_id, 'ada', ['design', 'ai'], { sub: 'ck_01JD8C4QJ7Z3K9W2X5V6N1M0PC' }, 'write']);
    assert.equal(c.exp - c.iat, DELEGATED_MAX_TTL_SEC, 'capped at 15 minutes');
    assert.ok(typeof c.jti === 'string' && c.jti.length >= 16);
    assert.throws(() => delegatedClaims({ user: ADA, services: ['design'] }), /who acts/);
    assert.throws(() => delegatedClaims({ user: ADA, by: 'ck_x12', services: [] }), /at least one service/);
    assert.throws(() => delegatedClaims({ user: ADA, by: 'ck_x12', services: ['design'], scope: 'admin' }), /read or write/);
});

test('refused as a session by default, everywhere (a typed token)', async () => {
    const t = sign(delegatedClaims({ user: ADA, by: 'ck_abc', services: ['design'], issuer: ISS }));
    await assert.rejects(verifyUserToken(t, opts()), (e) => e.code === 'token.not_user');
});

test('accepted only by a service it names: the person, role user, no staff claims, marked delegated', async () => {
    const claims = { ...delegatedClaims({ user: ADA, by: 'ck_abc', services: ['design', 'ai'], scope: 'read', issuer: ISS }), is_owner: true, staff_caps: ['money.manage'], staff_map: 3, role: 'admin' };
    const t = sign(claims);
    const got = await verifyUserToken(t, opts({ delegated: { service: 'design' } }));
    assert.deepEqual([got.sub, got.role, got.is_owner, got.staff_caps, got.staff_map], [7, 'user', undefined, undefined, undefined], 'never staff, even if the token says so');
    assert.deepEqual(got.delegated, { by: 'ck_abc', scope: 'read', services: ['design', 'ai'] });
    assert.ok(isDelegated(got));
    assert.ok((await verifyUserToken(t, opts({ delegated: { service: 'ai' } }))).delegated, 'the service it calls as you');
    await assert.rejects(verifyUserToken(t, opts({ delegated: { service: 'billing' } })), (e) => e.code === 'token.wrong_audience', 'not named: refused');
});

test('a delegated token without an actor, with a wrong scope, or living longer than 15 minutes is refused', async () => {
    const base = delegatedClaims({ user: ADA, by: 'ck_abc', services: ['design'], issuer: ISS });
    const o = opts({ delegated: { service: 'design' } });
    await assert.rejects(verifyUserToken(sign({ ...base, act: undefined }), o), (e) => e.code === 'token.invalid_claims');
    await assert.rejects(verifyUserToken(sign({ ...base, scope: 'admin' }), o), (e) => e.code === 'token.invalid_claims');
    await assert.rejects(verifyUserToken(sign({ ...base, exp: base.iat + DELEGATED_MAX_TTL_SEC + 60 }), o), (e) => e.code === 'token.invalid_claims');
    await assert.rejects(verifyUserToken(sign({ ...base, purpose: 'export' }), o), (e) => e.code === 'token.not_user', 'another typed token stays refused');
    assert.throws(() => checkDelegated(base, ''), /which service/);
});

test('a session is unchanged: no delegated mark, its role kept', async () => {
    const t = sign({ sub: 7, id: 7, username: 'ada', role: 'admin', iss: ISS, aud: ['openvibe.network'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
    const got = await verifyUserToken(t, opts({ delegated: { service: 'design' } }));
    assert.equal(got.role, 'admin');
    assert.ok(!isDelegated(got));
});

test('createSsoClient({ delegated: true }) accepts one for its own name; requireFullSession refuses it', async () => {
    const sso = createSsoClient({ site: 'design', baseUrl: 'https://openvibe.design', clientId: 'c', jwks, issuer: ISS, audience: ['openvibe.network'] });
    const ssoD = createSsoClient({ site: 'design', baseUrl: 'https://openvibe.design', clientId: 'c', jwks, issuer: ISS, audience: ['openvibe.network'], delegated: true });
    const t = sign(delegatedClaims({ user: ADA, by: 'ck_abc', services: ['design'], issuer: ISS }));
    assert.equal(await sso.verify(t), null, 'a site that did not opt in sees nobody');
    const claims = await ssoD.verify(t);
    assert.equal(claims.delegated.by, 'ck_abc');
    const run2 = (mw, token) => new Promise((resolve) => {
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, req }); } };
        mw(req, res, () => resolve({ status: 'next', req }));
    });
    const opt = await run2(ssoD.optionalAuth(), t);
    assert.equal(opt.status, 'next');
    assert.ok(opt.req.user && opt.req.user.delegated && opt.req.user.role === 'user');
    const full = await run2(ssoD.requireFullSession(), t);
    assert.deepEqual([full.status, full.body.error], [403, 'delegated.not_allowed']);
    const session = sign({ sub: 7, id: 7, username: 'ada', iss: ISS, aud: ['openvibe.network'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
    assert.equal((await run2(ssoD.requireFullSession(), session)).status, 'next', 'the person themselves passes');
    assert.equal((await run2(ssoD.requireFullSession(), '')).status, 401);
});

run(tests, 'auth-delegated');
