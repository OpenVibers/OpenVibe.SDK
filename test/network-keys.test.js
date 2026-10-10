'use strict';
/**
 * createNetworkKeys: a pinned PEM or Network's JWKS, retried until the first load, read by every verifier (user, app
 * and service tokens) through verifyOptions, with a rotation honoured on an unknown kid and keysFor() for a token a
 * service checks itself.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contracts = require('openvibe-contracts');
const { run, stubServer } = require('./helpers');
const { createNetworkKeys, verifyUserToken, verifyServiceToken, verifyAppToken } = require('../src/auth');

const ISS = 'https://openvibe.network';
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const K1 = pair(), K2 = pair(), ROGUE = pair();
const jwkOf = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(k, kid, claims) {
    const input = `${enc({ alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) })}.${enc(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), k.privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const user = (extra = {}) => ({ iss: ISS, sub: 7, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', aud: ['openvibe.network'], iat: now(), exp: now() + 300, ...extra });
const service = () => ({ iss: ISS, sub: 'svc:live', actor_type: 'service', aud: ['openvibe.events'], cap: ['events.event.publish'], ns: [], iat: now(), exp: now() + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` });
const app = () => ({ iss: ISS, sub: 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPR', actor_type: 'app', aud: ['openvibe.events'], cap: [], ns: ['prj_01JAB2C3D4E5F6G7H8J9K0MNPR'], project_id: 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR', env: 'production', iat: now(), exp: now() + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` });
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const quiet = { warn() {}, info() {} };

// A Network whose JWKS answers 503 until `up`, then serves `keys`; counts fetches.
async function network() {
    const n = { up: false, keys: [jwkOf(K1, 'k1')], fetches: 0 };
    n.srv = await stubServer(async (req, res) => {
        if (req.url !== '/api/.well-known/jwks') { res.statusCode = 404; return res.end(); }
        n.fetches += 1;
        if (!n.up) { res.statusCode = 503; return res.end(); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: n.keys }));
    });
    return n;
}

run([
    ['a pinned key is used as is: loaded at once, never fetched, read by every verifier', async () => {
        const pem = K1.publicKey.export({ type: 'spki', format: 'pem' });
        const keys = createNetworkKeys({ publicKey: pem, fetch: async () => { throw new Error('never fetched'); } });
        assert.equal(keys.loaded(), true);
        assert.equal(keys.pinned, true);
        assert.equal(await keys.start(), true);
        assert.equal((await verifyUserToken(sign(K1, null, user()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.network' })).sub, 7);
        const s = await verifyServiceToken(sign(K1, null, service()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.events', contracts });
        assert.equal(s.ok, true, JSON.stringify(s));
        assert.equal((await keys.keysFor('anything')).length, 1);
        assert.deepEqual(keys.status(), { source: 'pinned', url: null, ready: true, keys: 1 });
        keys.stop();
    }],

    ['without a key or a URL it refuses to start rather than verify nothing', async () => {
        assert.throws(() => createNetworkKeys({}), /pass `network`/);
    }],

    ['the JWKS is retried until it loads; then user, app and service tokens verify against it', async () => {
        const n = await network();
        const keys = createNetworkKeys({ network: `${n.srv.url}/`, retryMs: 20, log: quiet });
        try {
            assert.equal(keys.url, `${n.srv.url}/api/.well-known/jwks`, 'one slash');
            assert.equal(await keys.start(), false, 'Network still booting');
            assert.equal(keys.loaded(), false);
            assert.deepEqual(await keys.keysFor('k1'), [], 'nothing to verify with yet, and no throw');
            const early = await verifyServiceToken(sign(K1, 'k1', service()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.events', contracts });
            assert.equal(early.code, 'token.unavailable', 'no key yet is unavailable, not a bad token');
            n.up = true;
            await until(() => keys.loaded());
            const retries = n.fetches;
            await new Promise((r) => setTimeout(r, 80));
            assert.equal(n.fetches, retries, 'the retry stops once loaded');
            assert.equal((await verifyUserToken(sign(K1, 'k1', user()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.network' })).subject_id, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR');
            assert.equal((await verifyAppToken(sign(K1, 'k1', app()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.events' })).env, 'production');
            assert.equal((await verifyServiceToken(sign(K1, 'k1', service()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.events', contracts })).ok, true);
            assert.equal(keys.status().source, 'jwks');
            assert.equal(keys.status().ready, true);
            await assert.rejects(verifyUserToken(sign(K1, 'k1', user({ typ: 'realtime' })), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.network' }), { code: 'token.not_user' }, 'a typed token is never a session');
        } finally { keys.stop(); await n.srv.close(); }
    }],

    ['a rotation: a token naming a new kid verifies after one refetch, keysFor sees it, an unpublished key never verifies', async () => {
        const n = await network();
        n.up = true;
        const keys = createNetworkKeys({ jwksUrl: `${n.srv.url}/api/.well-known/jwks`, log: quiet });
        try {
            assert.equal(await keys.start(), true);
            const before = n.fetches;
            n.keys = [jwkOf(K2, 'k2'), jwkOf(K1, 'k1')];
            assert.equal((await verifyUserToken(sign(K2, 'k2', user()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.network' })).sub, 7);
            assert.equal(n.fetches, before + 1, 'one refetch');
            assert.deepEqual((await keys.keysFor('k2')).map((k) => k.kid), ['k2', 'k1']);
            const rogue = await verifyServiceToken(sign(ROGUE, 'k1', service()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.events', contracts });
            assert.equal(rogue.ok, false);
            assert.equal(rogue.code, 'token.bad_signature');
            await assert.rejects(verifyUserToken(sign(ROGUE, 'k1', user()), { ...keys.verifyOptions, issuer: ISS, audience: 'openvibe.network' }), { code: 'token.bad_signature' });
        } finally { keys.stop(); await n.srv.close(); }
    }],

    ['stop() ends the retry: a Network that never answers is not polled after shutdown', async () => {
        const n = await network();
        const keys = createNetworkKeys({ network: n.srv.url, retryMs: 20, log: quiet });
        try {
            await keys.start();
            keys.stop();
            const at = n.fetches;
            await new Promise((r) => setTimeout(r, 80));
            assert.equal(n.fetches, at);
            assert.equal(await keys.refresh(), null, 'a failed refresh answers null, never throws');
        } finally { await n.srv.close(); }
    }],
]);
