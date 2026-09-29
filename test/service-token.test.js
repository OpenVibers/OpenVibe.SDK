'use strict';
/** verifyServiceToken: the SDK's key choice, the service's own contracts rules; typed tokens are never user sessions. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const contracts = require('openvibe-contracts');
const { run } = require('./helpers');
const { verifyServiceToken, verifyUserToken } = require('../src/auth');

const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const a = pair(), b = pair(), stranger = pair();
const jwk = (pub, kid) => ({ ...pub.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid });
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const ISS = 'https://openvibe.network';
const svc = (over = {}) => ({ iss: ISS, sub: 'svc:live', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.avatar.ingest'], iat: now(), exp: now() + 300, jti: `tok_test_${String(++n).padStart(6, '0')}`, ...over });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims, key, kid) => { const input = `${b64({ alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) })}.${b64(claims)}`; return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`; };
const doc = { keys: [jwk(a.publicKey, 'old'), jwk(b.publicKey, 'new')] };
const opts = (over = {}) => ({ jwks: doc, issuer: ISS, audience: 'openvibe.media', contracts, ...over });

run([
    ['a service token verifies with the key its kid names (a rotation keeps two keys)', async () => {
        const r = await verifyServiceToken(sign(svc(), b.privateKey, 'new'), opts());
        assert.equal(r.ok, true, r.reason); assert.equal(r.claims.sub, 'svc:live');
        assert.equal((await verifyServiceToken(sign(svc(), a.privateKey, 'old'), opts())).ok, true);
        assert.equal((await verifyServiceToken(sign(svc(), a.privateKey), opts())).ok, true, 'no kid: each key is tried');
        const pem = a.publicKey.export({ type: 'spki', format: 'pem' });
        assert.equal((await verifyServiceToken(sign(svc(), a.privateKey, 'old'), opts({ jwks: null, publicKey: pem }))).ok, true, 'a pinned PEM');
    }],
    ['every rule is the contracts module\'s: signature, audience, issuer, sandbox, claim schema', async () => {
        assert.equal((await verifyServiceToken(sign(svc(), stranger.privateKey, 'new'), opts())).code, 'token.bad_signature');
        assert.equal((await verifyServiceToken(sign(svc({ aud: ['openvibe.live'] }), b.privateKey, 'new'), opts())).ok, false, 'another audience');
        assert.equal((await verifyServiceToken(sign(svc({ iss: 'https://evil.example' }), b.privateKey, 'new'), opts())).ok, false, 'another issuer');
        const sandbox = await verifyServiceToken(sign(svc({ sub: 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPQ', actor_type: 'app', env: 'sandbox', project_id: 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ', ns: ['prj_01JAB2C3D4E5F6G7H8J9K0MNPQ'] }), b.privateKey, 'new'), opts());
        assert.equal(sandbox.ok, false, 'a sandbox token'); 
        assert.equal((await verifyServiceToken(sign(svc({ jti: 'x' }), b.privateKey, 'new'), opts())).ok, false, 'claims outside identity.service-token-claims@1');
    }],
    ['no key at all is token.unavailable with a fixed reason (never the internal URL or the fetch error)', async () => {
        const logs = [];
        const r = await verifyServiceToken(sign(svc(), b.privateKey, 'new'), opts({ jwks: 'http://127.0.0.1:9/api/.well-known/jwks', log: { warn: (m) => logs.push(m) } }));
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'token.unavailable', 'signing key not loaded yet']);
        assert.ok(logs.some((m) => /127\.0\.0\.1:9/.test(m)), 'the real error goes to the log');
    }],
    ['a JWKS URL is fetched once through the shared client', async () => {
        let hits = 0;
        const srv = http.createServer((req, res) => { hits += 1; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(doc)); });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${srv.address().port}/api/.well-known/jwks`;
        try {
            for (let i = 0; i < 3; i++) assert.equal((await verifyServiceToken(sign(svc(), b.privateKey, 'new'), opts({ jwks: url }))).ok, true);
            assert.equal(hits, 1);
        } finally { srv.close(); }
    }],
    ['a JWKS client the service already holds: the key its kid names', async () => {
        const asked = [];
        const client = { keysForKid: async (kid) => { asked.push(kid); return [{ kid: 'old', key: a.publicKey }, { kid: 'new', key: b.publicKey }]; } };
        assert.equal((await verifyServiceToken(sign(svc(), b.privateKey, 'new'), opts({ jwks: client }))).ok, true);
        assert.equal((await verifyServiceToken(sign(svc(), stranger.privateKey, 'new'), opts({ jwks: client }))).code, 'token.bad_signature');
        assert.deepEqual(asked, ['new', 'new']);
        const down = { keysForKid: async () => { throw new Error('http://10.0.0.1/jwks unreachable'); } };
        assert.deepEqual(Object.values(await verifyServiceToken(sign(svc(), b.privateKey, 'new'), opts({ jwks: down }))), [false, 'token.unavailable', 'signing key not loaded yet']);
    }],
    ['misuse is a TypeError: no contracts module, no audience, no key source', async () => {
        await assert.rejects(verifyServiceToken('x.y.z', { jwks: doc, audience: 'openvibe.media' }), TypeError);
        await assert.rejects(verifyServiceToken('x.y.z', { jwks: doc, contracts }), TypeError);
        await assert.rejects(verifyServiceToken('x.y.z', { contracts, audience: 'openvibe.media' }), TypeError);
    }],
    ['a typed token (realtime ticket, FedCM assertion) is never a user session', async () => {
        const user = (over) => sign({ sub: 42, id: 42, username: 'ana', iss: ISS, aud: ['openvibe.network'], iat: now(), exp: now() + 300, ...over }, a.privateKey, 'old');
        assert.ok(await verifyUserToken(user({}), { jwks: doc, issuer: ISS, audience: 'openvibe.network' }), 'a session token');
        await assert.rejects(verifyUserToken(user({ typ: 'fedcm' }), { jwks: doc, issuer: ISS, audience: 'openvibe.network' }), { code: 'token.not_user' });
        await assert.rejects(verifyUserToken(user({ typ: 'realtime', purpose: 'realtime' }), { jwks: doc, issuer: ISS, audience: 'openvibe.network' }), { code: 'token.not_user' });
    }],
]);
