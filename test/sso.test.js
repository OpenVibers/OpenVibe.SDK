'use strict';
/** openvibe-sdk/sso: the site sign-in layer against a stub Network (token grants, revoke, JWKS). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { run } = require('./helpers');
const { createSsoClient, sanitizeNext, withParam, fedcmNonceMatches, failurePage } = require('../src/sso');

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
            if (body.grant_type === 'authorization_code' && (body.code === 'ov_health_check_never_issued' || body.code === 'used')) return send(400, { error: 'invalid_grant' });
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
    r.type = (t) => { r.contentType = t; return r; };
    r.set = (k, v) => { (r.headers = r.headers || {})[k] = v; return r; };
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
        // "Switch account" and "use another account" pass through, with the account to continue as (OIDC login_hint).
        const sw = fakeRes();
        await sso.handlers.login({ query: { prompt: 'select_account', login_hint: '@alt' }, headers: {} }, sw);
        assert.deepEqual([new URL(sw.location).searchParams.get('prompt'), new URL(sw.location).searchParams.get('login_hint')], ['select_account', '@alt']);
        const other = fakeRes();
        await sso.handlers.login({ query: { prompt: 'login' }, headers: {} }, other);
        assert.equal(new URL(other.location).searchParams.get('prompt'), 'login');
        const odd = fakeRes();
        await sso.handlers.login({ query: { prompt: 'consent', login_hint: '<b>x</b>' }, headers: {} }, odd);
        assert.deepEqual([new URL(odd.location).searchParams.get('prompt'), new URL(odd.location).searchParams.get('login_hint')], [null, null], 'anything else is dropped');
        const quiet = fakeRes();
        await sso.handlers.login({ query: { silent: '1', prompt: 'login' }, headers: {} }, quiet);
        assert.equal(new URL(quiet.location).searchParams.get('prompt'), 'none', 'silent stays silent');
    }],

    ['callback: the state cookie is required and must match; the code is exchanged with the secret and the PKCE verifier', async () => {
        // No state cookie, or another state: never a session; a fresh sign-in of the visitor's own, once (0.73.0).
        const noCookie = fakeRes();
        await sso.handlers.callback({ query: { code: 'c', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_next: '/deals' }) } }, noCookie);
        assert.equal(noCookie.statusCode, 302, 'no state cookie: start again');
        assert.equal(noCookie.location, '/auth/login?next=%2Fdeals', 'back to where the visitor was going');
        assert.equal(noCookie.cookies.ov_oauth_retry.v, '1');
        assert.ok(!noCookie.cookies.ov_token, 'no session without a matching state');
        const mismatch = fakeRes();
        await sso.handlers.callback({ query: { code: 'c', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 't', ov_oauth_verifier: 'v', ov_oauth_retry: '1' }) } }, mismatch);
        assert.equal(mismatch.statusCode, 400, 'the second time: the page, not another loop');
        assert.equal(mismatch.contentType, 'html');
        assert.match(mismatch.body, /<h1>Sign-in didn&#39;t finish<\/h1>/);
        assert.match(mismatch.body, /<a class="go" href="\/auth\/login">Try again<\/a>/);
        assert.ok(!mismatch.cookies.ov_token && mismatch.cleared.includes('ov_oauth_retry'), 'no session; the retry mark is spent');
        // A code the Network no longer accepts (used twice, too old): the same, once.
        const used = fakeRes();
        await sso.handlers.callback({ query: { code: 'used', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 's', ov_oauth_verifier: 'v' }) } }, used);
        assert.equal(used.statusCode, 302); assert.equal(used.location, '/auth/login'); assert.ok(!used.cookies.ov_token);
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

    ['a client the Network refuses: the page says it is our problem, logs what to check, and /auth/health reports it', async () => {
        const errors = [];
        const bad = createSsoClient({ site: 'cam', baseUrl: 'https://openvibe.cam', clientId: 'cam', clientSecret: '...', networkUrl: ISS, networkInternalUrl: base, issuer: ISS, log: { warn() {}, error: (m) => errors.push(m) } });
        const res = fakeRes();
        await bad.handlers.callback({ query: { code: 'c', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 's', ov_oauth_verifier: 'v' }) } }, res);
        assert.equal(res.statusCode, 500, 'no retry loop for a configuration error');
        assert.match(res.body, /Sign-in isn&#39;t working on OpenVibe\.Cam right now/);
        assert.match(res.body, /not with your account/);
        assert.ok(errors.some((m) => /refuses this site's OAuth client/.test(m) && /OV_OAUTH_CLIENT_SECRET/.test(m)), 'the log names what to check');
        const h = fakeRes();
        await bad.handlers.health({}, h);
        assert.deepEqual([h.statusCode, h.body], [503, { ok: false, client: 'invalid' }]);
        assert.equal(await bad.checkClient({ force: true }), 'invalid', 'a forced check asks the Network again');
        const good = fakeRes();
        await sso.handlers.health({}, good);
        assert.deepEqual([good.statusCode, good.body.client], [200, 'ok']);
        assert.equal(await sso.checkClient({ force: true }), 'ok', 'invalid_grant for a code that cannot exist: the client is fine');
        assert.ok(net.grants.some((g) => g.code === 'ov_health_check_never_issued'), 'the check presents the never-issued code');
        // The Network does not answer: the page, 502, no retry.
        const down = createSsoClient({ site: 'cam', baseUrl: 'https://openvibe.cam', clientId: 'cam', clientSecret: 'secret', networkUrl: 'http://127.0.0.1:9', networkInternalUrl: 'http://127.0.0.1:9', issuer: ISS, log: { warn() {}, error() {} } });
        const d = fakeRes();
        await down.handlers.callback({ query: { code: 'c', state: 's' }, headers: { cookie: cookieHeader({ ov_oauth_state: 's', ov_oauth_verifier: 'v' }) } }, d);
        assert.equal(d.statusCode, 502); assert.match(d.body, /OpenVibe\.Network didn&#39;t answer/);
        assert.equal(await down.checkClient({ force: true }), 'unknown', 'unreachable is unknown, not invalid');
        // The page escapes what it is given and needs nothing from outside.
        const page = failurePage({ siteName: '<b>X</b>', title: 'T"', text: "a'b", retryHref: '/auth/login?next=%2F%22x', backHref: '/' });
        assert.ok(!page.includes('<b>X</b>') && page.includes('&lt;b&gt;X&lt;/b&gt;') && page.includes('T&quot;') && page.includes('a&#39;b'));
        assert.ok(!/<script|https?:\/\//.test(page), 'no script and no outside request');
    }],

    ['legacy cookies: a site moving here keeps its sessions, then writes the SDK names and clears the old ones', async () => {
        const moved = createSsoClient({ site: 'cam', baseUrl: 'https://openvibe.cam', clientId: 'cam', clientSecret: 'secret', networkUrl: ISS, networkInternalUrl: base, issuer: ISS, audience: ['openvibe.network', 'openvibe.live'], legacyCookies: { access: ['cam_at'], refresh: [{ name: 'cam_rt', path: '/auth' }, 'bad name;'] }, log: { warn() {}, error() {} } });
        const me = fakeRes();
        await moved.handlers.me({ headers: { cookie: cookieHeader({ cam_at: session() }) } }, me);
        assert.equal(me.body.user.username, 'ana', 'the old access cookie is the session');
        const r = fakeRes();
        await moved.handlers.refresh({ headers: { cookie: cookieHeader({ cam_rt: 'old-rt' }) } }, r);
        assert.ok(r.body.token && r.cookies.ov_token && r.cookies.ov_refresh, 'the old refresh cookie refreshes; the SDK names are written');
        assert.equal(net.grants.at(-1).refresh_token, 'old-rt');
        assert.ok(r.cleared.includes('cam_at') && r.cleared.includes('cam_rt') && !r.cleared.includes('bad name;'), 'the old cookies are cleared; a bad name is ignored');
        const out = fakeRes();
        await moved.handlers.logout({ headers: { cookie: cookieHeader({ cam_rt: 'x' }) }, query: {} }, out);
        assert.ok(out.cleared.includes('cam_at') && out.cleared.includes('ov_token'), 'logout clears both');
        assert.ok(net.revoked.includes('x'), 'logout revokes the old refresh token too');
        net.revoked.splice(0);
    }],

    ['me and the middleware: a session verifies offline; a FedCM assertion, a service token, an expired token do not', async () => {
        const me = fakeRes();
        await sso.handlers.me({ headers: { cookie: cookieHeader({ ov_token: session() }) } }, me);
        assert.equal(me.statusCode, 200); assert.equal(me.body.user.username, 'ana'); assert.equal(me.body.user.iss, undefined);
        for (const [what, tok] of [['a FedCM assertion', session({ typ: 'fedcm', nonce: 'n' })], ['a service token', session({ sub: 'svc:live', actor_type: 'service' })], ['expired', session({ exp: now() - 600 })], ['another audience', session({ aud: ['openvibe.elsewhere'] })]]) {
            const r = fakeRes();
            await sso.handlers.me({ headers: { authorization: `Bearer ${tok}` } }, r);
            assert.deepEqual([r.statusCode, r.body.user], [200, null], `${what}: signed out answers 200 with no user`);
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
