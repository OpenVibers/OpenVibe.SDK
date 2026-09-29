'use strict';
/** openvibe-sdk/sso: the site sign-in layer against a stub Network (token grants, revoke, JWKS). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { run } = require('./helpers');
const { createSsoClient, sanitizeNext, withParam, fedcmNonceMatches } = require('../src/sso');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => { const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`; return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`; };
const session = (over = {}) => sign({ sub: 7, id: 7, username: 'ana', iss: ISS, aud: ['openvibe.network', 'openvibe.live'], iat: now(), exp: now() + 600, ...over });

// A stub Network: /oauth/token (code, refresh, jwt-bearer), /oauth/revoke, the JWKS.
const net = { grants: [], revoked: [], refuseRefresh: false };
const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.url === '/api/.well-known/jwks') return send(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/oauth/revoke') { net.revoked.push(body.token); return send(200, { revoked: true }); }
        if (req.url === '/oauth/token') {
            net.grants.push(body);
            if (body.client_secret !== 'secret') return send(401, { error: 'invalid_client' });
            if (body.grant_type === 'refresh_token' && net.refuseRefresh) return send(400, { error: 'invalid_grant' });
            return send(200, { access_token: session(), refresh_token: `rt_${net.grants.length}`, token_type: 'Bearer' });
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
    return r;
}
const cookieHeader = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

let sso, base;
run([
    ['next: same-site paths, this site and the Network only; control characters and backslashes go home', async () => {
        const o = { baseUrl: 'https://openvibe.trade', networkUrl: ISS };
        assert.equal(sanitizeNext('/a/b?c=1', o), '/a/b?c=1');
        for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example/', 'http://openvibe.trade/x', 'javascript:alert(1)', '', null]) assert.equal(sanitizeNext(bad, o), '/', String(bad));
        assert.equal(sanitizeNext('https://openvibe.trade/x', o), 'https://openvibe.trade/x');
        assert.equal(sanitizeNext('https://openvibe.network/oauth/authorize?x=1', o), 'https://openvibe.network/oauth/authorize?x=1');
        assert.equal(withParam('/a?b=1#h', 'sso', 'none'), '/a?b=1&sso=none#h');
    }],

    ['login: state + PKCE (S256), silent is prompt=none, next is sanitized', async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        sso = createSsoClient({ site: 'trade', baseUrl: 'https://openvibe.trade', clientId: 'trade', clientSecret: 'secret', networkUrl: ISS, networkInternalUrl: base, issuer: ISS, log: { warn() {}, error() {}, info() {} } });
        const res = fakeRes();
        await sso.handlers.login({ query: { next: '//evil.example' }, headers: {} }, res);
        const u = new URL(res.location);
        assert.equal(u.origin + u.pathname, `${ISS}/oauth/authorize`);
        assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('code_challenge_method')], ['trade', 'https://openvibe.trade/auth/callback', 'S256']);
        assert.equal(u.searchParams.get('state'), res.cookies.ov_oauth_state.v);
        assert.equal(u.searchParams.get('code_challenge'), crypto.createHash('sha256').update(res.cookies.ov_oauth_verifier.v).digest('base64url'), 'the challenge is S256 of the stored verifier');
        assert.equal(res.cookies.ov_oauth_state.o.httpOnly, true); assert.equal(res.cookies.ov_oauth_state.o.path, '/auth');
        assert.ok(!res.cookies.ov_oauth_next, 'an unsafe next is not kept');
        const silent = fakeRes();
        await sso.handlers.login({ query: { silent: '1', next: '/deals' }, headers: {} }, silent);
        assert.equal(new URL(silent.location).searchParams.get('prompt'), 'none');
        assert.equal(silent.cookies.ov_oauth_next.v, '/deals');
    }],

    ['callback: the state cookie is required and must match; the code is exchanged with the secret and the PKCE verifier', async () => {
        const noCookie = fakeRes();
        await sso.handlers.callback({ query: { code: 'c', state: 's' }, headers: {} }, noCookie);
        assert.equal(noCookie.statusCode, 400, 'no state cookie');
        const mismatch = fakeRes();
        await sso.handlers.callback({ query: { code: 'c', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 't', ov_oauth_verifier: 'v' }) } }, mismatch);
        assert.equal(mismatch.statusCode, 400, 'another state');
        const ok = fakeRes();
        await sso.handlers.callback({ query: { code: 'c1', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 's', ov_oauth_verifier: 'ver', ov_oauth_next: '/deals' }) } }, ok);
        assert.equal(ok.location, '/deals');
        const g = net.grants.at(-1);
        assert.deepEqual([g.grant_type, g.code, g.code_verifier, g.client_secret, g.redirect_uri], ['authorization_code', 'c1', 'ver', 'secret', 'https://openvibe.trade/auth/callback']);
        assert.ok(ok.cookies.ov_token && ok.cookies.ov_refresh && ok.cookies.ov_sso_hint.v === 'account');
        assert.equal(ok.cookies.ov_token.o.httpOnly, false, 'the shared navbar reads the access token');
        assert.equal(ok.cookies.ov_refresh.o.httpOnly, true); assert.equal(ok.cookies.ov_refresh.o.path, '/auth');
        const quiet = fakeRes();
        await sso.handlers.callback({ query: { error: 'login_required' }, headers: { cookie: cookieHeader({ ov_oauth_silent: '1', ov_oauth_next: '/x' }) } }, quiet);
        assert.equal(quiet.location, '/x?sso=none', 'a silent sign-in with no Network session goes back quietly');
    }],

    ['me and the middleware: a session verifies offline; a FedCM assertion, a service token, an expired token do not', async () => {
        const me = fakeRes();
        await sso.handlers.me({ headers: { cookie: cookieHeader({ ov_token: session() }) } }, me);
        assert.equal(me.statusCode, 200); assert.equal(me.body.user.username, 'ana'); assert.equal(me.body.user.iss, undefined);
        for (const [what, tok] of [['a FedCM assertion', session({ typ: 'fedcm', nonce: 'n' })], ['a service token', session({ sub: 'svc:live', actor_type: 'service' })], ['expired', session({ exp: now() - 600 })], ['another audience', session({ aud: ['openvibe.elsewhere'] })]]) {
            const r = fakeRes();
            await sso.handlers.me({ headers: { authorization: `Bearer ${tok}` } }, r);
            assert.equal(r.statusCode, 401, what);
        }
        const req = { headers: { authorization: `Bearer ${session()}` } };
        await new Promise((done) => sso.optionalAuth()(req, {}, done));
        assert.equal(req.user.username, 'ana');
        const denied = fakeRes();
        await new Promise((done) => { sso.requireAuth()({ headers: {} }, denied, done); setTimeout(done, 50); });
        assert.equal(denied.statusCode, 401);
    }],

    ['fedcm: the nonce is pre-checked; a matching assertion is swapped for a session', async () => {
        const assertion = session({ typ: 'fedcm', nonce: 'n-123' });
        assert.equal(fedcmNonceMatches(assertion, 'n-123'), true);
        const bad = fakeRes();
        await sso.handlers.fedcm({ body: { token: assertion, nonce: 'other' }, headers: {} }, bad);
        assert.equal(bad.statusCode, 400);
        const ok = fakeRes();
        await sso.handlers.fedcm({ body: { token: assertion, nonce: 'n-123' }, headers: {} }, ok);
        assert.equal(ok.body.ok, true); assert.equal(net.grants.at(-1).grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        assert.ok(ok.cookies.ov_token);
    }],

    ['refresh rotates; a refused refresh ends the session; logout revokes and hints guest', async () => {
        const r = fakeRes();
        await sso.handlers.refresh({ headers: { cookie: cookieHeader({ ov_refresh: 'rt_a' }) } }, r);
        assert.equal(r.statusCode, 200); assert.ok(r.body.token); assert.equal(net.grants.at(-1).refresh_token, 'rt_a');
        net.refuseRefresh = true;
        const refused = fakeRes();
        await sso.handlers.refresh({ headers: { cookie: cookieHeader({ ov_refresh: 'rt_b' }) } }, refused);
        assert.equal(refused.statusCode, 401); assert.ok(refused.cleared.includes('ov_token') && refused.cleared.includes('ov_refresh'));
        const out = fakeRes();
        await sso.handlers.logout({ query: { next: 'https://evil.example' }, headers: { cookie: cookieHeader({ ov_refresh: 'rt_c' }) } }, out);
        assert.deepEqual(net.revoked, ['rt_c']); assert.equal(out.cookies.ov_sso_hint.v, 'guest'); assert.equal(out.location, '/');
        server.close();
    }],

    ['misuse: baseUrl and clientId are required; router() needs the express module', async () => {
        assert.throws(() => createSsoClient({ clientId: 'x' }), TypeError);
        assert.throws(() => sso.router(null), TypeError);
    }],
]);
