'use strict';
/** openvibe-sdk/app-signin: the developer-app sign-in against a stub Network (token grants, JWKS). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { run } = require('./helpers');
const { createAppSignIn } = require('../src/app-signin');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
};
const ID = '01J8Z5N4K2M9Q7R3T6W8Y0X1CD';   // 26 Crockford base32 characters, as a ULID is
const APP = `app_${ID}`;
const OTHER_APP = `app_${ID.slice(0, 25)}E`;
const USER = `usr_${ID}`;
const PROJECT = `prj_${ID}`;

const appToken = (over = {}) => sign({
    sub: `app:${APP}`, actor_type: 'app', aud: ['openvibe.media'], cap: ['media.object.read'],
    project_id: PROJECT, env: 'production', on_behalf_of: USER, jti: 'j1', iss: ISS, iat: now(), exp: now() + 300, ...over,
});

// A stub Network: /oauth/token (the code exchange and the health check) and the JWKS.
const net = { grants: [], secret: 'secret', refuseCode: null, mint: null };
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.url === '/api/.well-known/jwks') return send(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
        if (req.url === '/oauth/token') {
            const body = Object.fromEntries(new URLSearchParams(raw));
            net.grants.push(body);
            if (body.client_secret !== net.secret) return send(401, { error: 'invalid_client' });
            if (body.code === 'ov_app_health_check_never_issued') return send(400, { error: 'invalid_grant' });
            if (net.refuseCode && body.code === net.refuseCode) return send(400, { error: 'invalid_grant', error_description: 'code already used' });
            return send(200, { access_token: net.mint ? net.mint() : appToken(), token_type: 'Bearer', expires_in: 300, scope: body.scope });
        }
        return send(404, {});
    });
});

function fakeRes() {
    const r = { cookies: {}, cleared: [], statusCode: 200 };
    r.cookie = (k, v, o) => { r.cookies[k] = { v, o }; return r; };
    r.clearCookie = (k) => { r.cleared.push(k); return r; };
    r.redirect = (u) => { r.statusCode = 302; r.location = u; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = b; return r; };
    r.type = (t) => { r.contentType = t; return r; };
    r.set = (k, v) => { (r.headers = r.headers || {})[k] = v; return r; };
    return r;
}
const cookieHeader = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

let base, signIn;
const opts = (over = {}) => ({
    clientId: APP, clientSecret: 'secret', redirectUri: 'https://app.example/auth/callback',
    networkUrl: ISS, audience: 'openvibe.media', scope: ['media.object.read'],
    log: { log() {}, warn() {}, error() {} }, ...over,
});

run([
    ['login: the audience, the capabilities and a PKCE challenge go to the Network; the state and the verifier stay on the server', async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        signIn = createAppSignIn(opts({ networkUrl: `${base}`, issuer: ISS }));
        const res = fakeRes();
        await signIn.handlers.login({ query: {}, headers: {} }, res);
        assert.equal(res.statusCode, 302);
        const u = new URL(res.location);
        assert.equal(`${u.origin}${u.pathname}`, `${base}/oauth/authorize`);
        assert.equal(u.searchParams.get('client_id'), APP);
        assert.equal(u.searchParams.get('audience'), 'openvibe.media');
        assert.equal(u.searchParams.get('scope'), 'media.object.read');
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(u.searchParams.get('state'));
        // The browser holds an opaque id only: no state, no verifier, no token.
        const sid = res.cookies.ov_app_sid.v;
        assert.ok(sid && !sid.includes(u.searchParams.get('state')));
        assert.ok(!JSON.stringify(res.cookies).includes('code_verifier'));
        assert.ok(res.cookies.ov_app_sid.o.httpOnly);
    }],

    ['callback: the state must match, the code is exchanged once with the secret and the verifier, and the token must be ours', async () => {
        net.grants.length = 0;
        const start = fakeRes();
        await signIn.handlers.login({ query: {}, headers: {} }, start);
        const sid = start.cookies.ov_app_sid.v;
        const state = new URL(start.location).searchParams.get('state');
        // The verifier the Network saw is the one the SDK kept: the stub accepts it.
        const ok = fakeRes();
        await signIn.handlers.callback({ query: { code: 'the-code', state }, url: '/auth/callback?code=the-code&state=' + state, headers: { cookie: `ov_app_sid=${sid}` } }, ok);
        assert.equal(ok.statusCode, 302);
        assert.equal(ok.location, '/');
        const g = net.grants.at(-1);
        assert.equal(g.grant_type, 'authorization_code');
        assert.equal(g.client_id, APP);
        assert.equal(g.client_secret, 'secret');
        assert.equal(g.redirect_uri, 'https://app.example/auth/callback');
        assert.equal(g.audience, 'openvibe.media');
        assert.equal(g.scope, 'media.object.read');
        assert.match(g.code_verifier, /^[A-Za-z0-9_-]{43,128}$/, 'the PKCE verifier the SDK kept is the one sent');
        assert.ok(g.code_verifier && !ok.location.includes(g.code_verifier));

        // The new session id: no session fixation.
        assert.notEqual(ok.cookies.ov_app_sid.v, sid);
        const cookie = `ov_app_sid=${ok.cookies.ov_app_sid.v}`;
        const me = fakeRes();
        await signIn.handlers.me({ headers: { cookie } }, me);
        assert.equal(me.body.user.subject, USER);
        assert.deepEqual(me.body.user.capabilities, ['media.object.read']);
        assert.equal(me.body.user.app, `app:${APP}`);
        assert.ok(!JSON.stringify(me.body).includes('eyJ'), 'no token in the answer');
        assert.ok(!JSON.stringify(ok.cookies).includes('eyJ'), 'no token in the cookie');

        // Signed out: no user.
        const out = fakeRes();
        await signIn.handlers.logout({ query: {}, headers: { cookie } }, out);
        assert.equal(out.statusCode, 302);
        assert.ok(out.cleared.includes('ov_app_sid'));
        const after = fakeRes();
        await signIn.handlers.me({ headers: { cookie } }, after);
        assert.equal(after.body.user, null);
    }],

    ['a token minted for another app is refused before on_behalf_of is trusted', async () => {
        net.mint = () => appToken({ sub: `app:${OTHER_APP}`, on_behalf_of: 'usr_01J8Z5N4K2M9Q7R3T6W8Y0X1D' });
        const start = fakeRes();
        await signIn.handlers.login({ query: {}, headers: {} }, start);
        const state = new URL(start.location).searchParams.get('state');
        const res = fakeRes();
        await signIn.handlers.callback({ query: { code: 'the-code', state }, url: '/auth/callback?code=the-code&state=' + state, headers: { cookie: `ov_app_sid=${start.cookies.ov_app_sid.v}` } }, res);
        assert.equal(res.statusCode, 400);
        assert.match(res.body, /does not name a person for this app/);
        net.mint = null;
    }],

    ['recovery: a lost flow or a used code starts the sign-in once more, then the same page the site sign-in shows', async () => {
        net.grants.length = 0;
        // A callback this browser did not start (a forged state).
        const forged = fakeRes();
        await signIn.handlers.callback({ query: { code: 'the-code', state: 'not-the-state' }, url: '/auth/callback?code=the-code&state=not-the-state', headers: { cookie: 'ov_app_sid=someone-else' } }, forged);
        assert.equal(forged.statusCode, 302, 'the first time: it starts again');
        assert.equal(forged.location, '/login');
        assert.ok(forged.cookies.ov_app_sid, 'a session to carry the retry mark');

        // The second failure: the page, not another loop.
        const again = fakeRes();
        await signIn.handlers.callback({ query: { code: 'the-code', state: 'not-the-state' }, url: '/auth/callback?code=the-code&state=not-the-state', headers: { cookie: `ov_app_sid=${forged.cookies.ov_app_sid.v}` } }, again);
        assert.equal(again.statusCode, 400);
        assert.equal(again.contentType, 'html');
        assert.match(again.body, /<h1>Sign-in didn&#39;t finish<\/h1>/);
        assert.match(again.body, /<a class="go" href="\/login">Try again<\/a>/);

        // A code the Network no longer accepts: the same, once.
        net.refuseCode = 'used-code';
        const start = fakeRes();
        await signIn.handlers.login({ query: {}, headers: {} }, start);
        const state = new URL(start.location).searchParams.get('state');
        const used = fakeRes();
        await signIn.handlers.callback({ query: { code: 'used-code', state }, url: '/auth/callback?code=used-code&state=' + state, headers: { cookie: `ov_app_sid=${start.cookies.ov_app_sid.v}` } }, used);
        assert.equal(used.statusCode, 302);
        assert.equal(used.location, '/login');
        net.refuseCode = null;
    }],

    ['health: does the Network accept this app\'s credentials?', async () => {
        assert.equal(await signIn.checkClient(), 'ok');
        const res = fakeRes();
        await signIn.handlers.health({ headers: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: true, client: 'ok' });

        const other = createAppSignIn(opts({ networkUrl: `${base}`, issuer: ISS, clientSecret: 'wrong' }));
        assert.equal(await other.checkClient(), 'invalid');
        const bad = fakeRes();
        await other.handlers.health({ headers: {} }, bad);
        assert.equal(bad.statusCode, 503);
        assert.deepEqual(bad.body, { ok: false, client: 'invalid' });
    }],

    ['the router is the five routes', async () => {
        const routes = [];
        const express = { Router: () => ({ get: (p) => routes.push(`GET ${p}`), post: (p) => routes.push(`POST ${p}`) }) };
        signIn.router(express);
        assert.deepEqual(routes, ['GET /login', 'GET /callback', 'GET /logout', 'GET /me', 'GET /health']);
        assert.throws(() => signIn.router(null), /pass the express module/);
        server.close();
    }],
]);
