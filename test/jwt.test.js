'use strict';
/** Offline RS256 verification of Network user tokens. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, run } = require('./helpers');
const { verifyUserToken } = require('../src/auth');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, key, header = { alg: 'RS256', typ: 'JWT', kid: 'k1' }) {
    const input = `${b64(header)}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const good = pair();
const other = pair();
const jwk = (pub, kid) => ({ ...pub.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid });
const jwks = { keys: [jwk(good.publicKey, 'k1')] };
const now = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ sub: 42, id: 42, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', username: 'ana', role: 'user', iss: 'https://openvibe.network', aud: ['openvibe.live', 'openvibe.network'], iat: now(), exp: now() + 600, ...over });

run([
    ['a good token verifies and returns claims with subject_id', async () => {
        const c = await verifyUserToken(sign(claims(), good.privateKey), { jwks, issuer: 'https://openvibe.network', audience: 'openvibe.live' });
        assert.equal(c.subject_id, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.equal(c.username, 'ana');
        const pem = good.publicKey.export({ type: 'spki', format: 'pem' });
        assert.equal((await verifyUserToken(sign(claims(), good.privateKey), { publicKey: pem })).sub, 42);
        assert.equal((await verifyUserToken(sign(claims(), good.privateKey, { alg: 'RS256' }), { jwks: { public_key: pem } })).sub, 42, 'Network legacy public_key shape');
    }],

    ['expired (beyond skew) is token.expired', async () => {
        await assert.rejects(verifyUserToken(sign(claims({ exp: now() - 120 }), good.privateKey), { jwks }), { code: 'token.expired', status: 401 });
        assert.ok(await verifyUserToken(sign(claims({ exp: now() - 10 }), good.privateKey), { jwks }), 'within the 30 s skew');
        await assert.rejects(verifyUserToken(sign(claims({ exp: undefined }), good.privateKey), { jwks }), { code: 'token.expired' });
        await assert.rejects(verifyUserToken(sign(claims({ nbf: now() + 600 }), good.privateKey), { jwks }), { code: 'token.not_yet_valid' });
    }],

    ['a token signed by another key is token.bad_signature', async () => {
        await assert.rejects(verifyUserToken(sign(claims(), other.privateKey), { jwks }), { code: 'token.bad_signature' });
        const tampered = sign(claims(), good.privateKey).split('.');
        tampered[1] = b64(claims({ role: 'admin' }));
        await assert.rejects(verifyUserToken(tampered.join('.'), { jwks }), { code: 'token.bad_signature' });
    }],

    ['alg none / HS256 / garbage are refused before any key is used', async () => {
        const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`;
        await assert.rejects(verifyUserToken(none, { jwks }), { code: 'token.malformed' });
        const noneSig = `${b64({ alg: 'none' })}.${b64(claims())}.c2ln`;
        await assert.rejects(verifyUserToken(noneSig, { jwks }), { code: 'token.malformed' });
        const pem = good.publicKey.export({ type: 'spki', format: 'pem' });
        const hsInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims())}`;
        const hs = `${hsInput}.${crypto.createHmac('sha256', pem).update(hsInput).digest('base64url')}`;
        await assert.rejects(verifyUserToken(hs, { publicKey: pem }), { code: 'token.malformed' }, 'key-confusion attack');
        await assert.rejects(verifyUserToken('not.a.jwt', { jwks }), { code: 'token.malformed' });
        await assert.rejects(verifyUserToken(undefined, { jwks }), { code: 'token.malformed' });
    }],

    ['issuer, audience and service-principal tokens', async () => {
        await assert.rejects(verifyUserToken(sign(claims(), good.privateKey), { jwks, issuer: 'https://evil.example' }), { code: 'token.wrong_issuer' });
        await assert.rejects(verifyUserToken(sign(claims(), good.privateKey), { jwks, audience: 'openvibe.games' }), { code: 'token.wrong_audience' });
        const svc = sign({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: ['openvibe.network'], cap: [], iat: now(), exp: now() + 300, jti: 'tok_1' }, good.privateKey);
        await assert.rejects(verifyUserToken(svc, { jwks }), { code: 'token.not_user' });
        assert.equal((await verifyUserToken(svc, { jwks, allowServiceTokens: true })).sub, 'svc:live');
        await assert.rejects(verifyUserToken(sign(claims(), good.privateKey), { jwks: { keys: [] } }), { code: 'token.no_key' });
    }],

    ['a JWKS URL is fetched once, cached, and refetched for an unknown kid', async () => {
        let current = { keys: [jwk(good.publicKey, 'k1')] };
        const srv = await stubServer((req, res) => send(res, 200, current));
        const url = `${srv.url}/api/.well-known/jwks`;
        await verifyUserToken(sign(claims(), good.privateKey), { jwks: url });
        await verifyUserToken(sign(claims(), good.privateKey), { jwks: url });
        assert.equal(srv.requests.length, 1);
        current = { keys: [jwk(good.publicKey, 'k1'), jwk(other.publicKey, 'k2')] };   // rotation
        const c = await verifyUserToken(sign(claims(), other.privateKey, { alg: 'RS256', kid: 'k2' }), { jwks: url });
        assert.equal(c.sub, 42);
        assert.equal(srv.requests.length, 2);
        await assert.rejects(verifyUserToken(sign(claims(), other.privateKey, { alg: 'RS256', kid: 'k1' }), { jwks: url }), { code: 'token.bad_signature' });
        await srv.close();
    }],
]);
