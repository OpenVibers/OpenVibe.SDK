'use strict';
/**
 * Subject assertions (ADR-003, the 2026-11-06 amendment; plan H1): asking Network to sign the
 * person's own token, and checking the answer.
 *
 * A forged, expired, replayed, wrong-audience or wrong-service assertion is refused, and a caller
 * without the person's token gets nothing.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const { requestSubjectAssertion, verifySubjectAssertion, createSubjectAssertionVerifier } = require('../src/assertions');

const PERSON = 'usr_01H8XYZABCDEFGHJKMNPQRRSTV';
const OTHER = 'usr_01H8XYZABCDEFGHJKMNPQRRSTW';

/** An EC (ES256) key pair, Network's assertion key in the test. */
function keyPair() { return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); }

/** The JWKS document Network publishes for its assertion key. */
function jwks(pub, kid = 'ov-network-assertion-1') {
    return { keys: [{ ...pub.export({ format: 'jwk' }), use: 'sig', alg: 'ES256', kid }] };
}

const b64url = (b) => Buffer.from(b).toString('base64url');

/** Sign claims the way Network does (ES256, raw r||s). */
function sign(claims, priv, kid = 'ov-network-assertion-1') {
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), { key: priv, dsaEncoding: 'ieee-p1363' });
    return `${header}.${body}.${b64url(sig)}`;
}

/** The claims of a fresh assertion. */
function claims(over = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: 'https://openvibe.network', sub: PERSON, aud: 'openvibe.billing', act: 'svc:live', jti: `as_${crypto.randomBytes(8).toString('hex')}`, iat: now, exp: now + 60, ...over };
}

run([
    ['a good assertion verifies and carries the person, the service and the jti', async () => {
        const kp = keyPair();
        const c = claims();
        const r = await verifySubjectAssertion(sign(c, kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, true);
        assert.equal(r.claims.sub, PERSON);
        assert.equal(r.claims.act, 'svc:live');
        assert.equal(r.claims.jti, c.jti);
    }],

    ['a forged assertion (another key) is refused', async () => {
        const mine = keyPair(), theirs = keyPair();
        const r = await verifySubjectAssertion(sign(claims(), theirs.privateKey), { jwks: jwks(mine.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.bad_signature');
    }],

    ['a tampered claim (another person) does not verify', async () => {
        const kp = keyPair();
        const token = sign(claims(), kp.privateKey);
        const [h, p, s] = token.split('.');
        const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
        body.sub = OTHER;
        const forged = `${h}.${b64url(JSON.stringify(body))}.${s}`;
        const r = await verifySubjectAssertion(forged, { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.bad_signature');
    }],

    ['an expired assertion is refused', async () => {
        const kp = keyPair();
        const now = Math.floor(Date.now() / 1000);
        const r = await verifySubjectAssertion(sign(claims({ iat: now - 600, exp: now - 300 }), kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.expired');
    }],

    ['an assertion for another audience is refused', async () => {
        const kp = keyPair();
        const r = await verifySubjectAssertion(sign(claims({ aud: 'openvibe.tips' }), kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.wrong_audience');
    }],

    ['an assertion minted for another service is refused', async () => {
        const kp = keyPair();
        const r = await verifySubjectAssertion(sign(claims({ act: 'svc:vip' }), kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing', caller: 'svc:live' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.actor_mismatch');
    }],

    ['an assertion a chain may carry is accepted by the service it names', async () => {
        const kp = keyPair();
        // Live vouches for the person; Tips may carry it on to Billing.
        const c = claims({ act: 'svc:live', for: ['svc:live', 'svc:tips'], aud: ['openvibe.tips', 'openvibe.billing'] });
        const r = await verifySubjectAssertion(sign(c, kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing', caller: 'svc:tips' });
        assert.equal(r.ok, true);
        assert.equal(r.claims.sub, PERSON);
        const other = await verifySubjectAssertion(sign(c, kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing', caller: 'svc:vip' });
        assert.equal(other.ok, false);
        assert.equal(other.code, 'assertion.actor_mismatch');
    }],

    ['an assertion naming no person is refused', async () => {
        const kp = keyPair();
        const r = await verifySubjectAssertion(sign(claims({ sub: 'not-a-subject' }), kp.privateKey), { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.invalid_claims');
    }],

    ['a replayed assertion is refused the second time', async () => {
        const kp = keyPair();
        const v = createSubjectAssertionVerifier({ jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        const token = sign(claims(), kp.privateKey);
        const first = await v.verify(token);
        assert.equal(first.ok, true);
        const second = await v.verify(token);
        assert.equal(second.ok, false);
        assert.equal(second.code, 'assertion.replayed');
    }],

    ['an alg=none assertion is refused', async () => {
        const kp = keyPair();
        const c = claims();
        const token = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(c))}.`;
        const r = await verifySubjectAssertion(token, { jwks: jwks(kp.publicKey), audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.malformed');
    }],

    ['no key at all is refused, not accepted', async () => {
        const kp = keyPair();
        const r = await verifySubjectAssertion(sign(claims(), kp.privateKey), { jwks: { keys: [] }, audience: 'openvibe.billing' });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'assertion.no_key');
    }],

    ['asking for an assertion sends the person\'s own token and the caller\'s token', async () => {
        let seen = null;
        const fetchImpl = async (url, opts) => {
            seen = { url, opts };
            return { ok: true, status: 200, json: async () => ({ assertion: 'a.b.c', subject: PERSON, audience: 'openvibe.billing', jti: 'as_1', expires_in: 60 }) };
        };
        const out = await requestSubjectAssertion({
            userToken: 'person-token', audience: 'openvibe.billing', internalUrl: 'http://127.0.0.1:4000', token: 'service-token', fetch: fetchImpl,
        });
        assert.equal(seen.url, 'http://127.0.0.1:4000/internal/subject-assertions');
        assert.equal(seen.opts.headers.Authorization, 'Bearer service-token');
        assert.deepEqual(JSON.parse(seen.opts.body), { user_token: 'person-token', audience: 'openvibe.billing' });
        assert.equal(out.assertion, 'a.b.c');
        assert.equal(out.subject, PERSON);
    }],

    ['a caller without the person\'s token gets nothing', async () => {
        await assert.rejects(requestSubjectAssertion({ audience: 'openvibe.billing', token: 'service-token' }), /own access token is required/);
    }],

    ['a refusal from Network is an error, not an assertion', async () => {
        const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ code: 'assertion.no_user_token', detail: 'that token names no person' }) });
        await assert.rejects(
            requestSubjectAssertion({ userToken: 'x', audience: 'openvibe.billing', token: 'service-token', internalUrl: 'http://127.0.0.1:4000', fetch: fetchImpl }),
            (err) => { assert.equal(err.status, 401); assert.match(err.message, /names no person/); return true; },
        );
    }],

    ['a token client may bring its own token', async () => {
        let seen = null;
        const fetchImpl = async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({ assertion: 'a.b.c' }) }; };
        await requestSubjectAssertion({
            userToken: 'person-token', audience: 'openvibe.billing', internalUrl: 'http://127.0.0.1:4000',
            tokenClient: { getToken: async () => 'from-client' }, fetch: fetchImpl,
        });
        assert.equal(seen.headers.Authorization, 'Bearer from-client');
    }],
]);
