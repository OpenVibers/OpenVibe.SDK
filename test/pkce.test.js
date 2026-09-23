'use strict';
/** PKCE (RFC 7636 S256), authorize URL, callback parsing, and the server-side code exchange. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const browser = require('../src/auth/browser');
const { exchangeCode, refreshUserToken, verifyUserToken } = require('../src/auth');
const { createMockPlatform } = require('../src/testing');

const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

run([
    ['RFC 7636 appendix B vector', async () => {
        assert.equal(await browser.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    }],

    ['verifiers are 43..128 unreserved characters and the challenge is S256 of them', async () => {
        for (const len of [43, 64, 128]) {
            const { codeVerifier, codeChallenge, codeChallengeMethod } = await browser.createPkcePair(len);
            assert.equal(codeVerifier.length, len);
            assert.match(codeVerifier, /^[A-Za-z0-9\-._~]+$/);
            assert.equal(codeChallenge, s256(codeVerifier));
            assert.equal(codeChallengeMethod, 'S256');
        }
        assert.throws(() => browser.createCodeVerifier(42), RangeError);
        assert.throws(() => browser.createCodeVerifier(129), RangeError);
        const a = browser.createCodeVerifier();
        const b = browser.createCodeVerifier();
        assert.notEqual(a, b);
    }],

    ['authorize URL carries every parameter', async () => {
        const { url, state, codeVerifier, codeChallenge } = await browser.startAuthorization({ clientId: 'demo', redirectUri: 'https://demo.example/cb', scope: ['profile', 'theme'] });
        const u = new URL(url);
        assert.equal(u.origin + u.pathname, 'https://openvibe.network/oauth/authorize');
        assert.equal(u.searchParams.get('response_type'), 'code');
        assert.equal(u.searchParams.get('client_id'), 'demo');
        assert.equal(u.searchParams.get('redirect_uri'), 'https://demo.example/cb');
        assert.equal(u.searchParams.get('scope'), 'profile theme');
        assert.equal(u.searchParams.get('state'), state);
        assert.equal(u.searchParams.get('code_challenge'), codeChallenge);
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(codeChallenge, s256(codeVerifier));
        assert.ok(state.length >= 32);
        const silent = new URL(browser.buildAuthorizeUrl({ network: 'http://127.0.0.1:4000/', clientId: 'x', redirectUri: 'http://a/b', prompt: 'none' }));
        assert.equal(silent.origin, 'http://127.0.0.1:4000');
        assert.equal(silent.searchParams.get('prompt'), 'none');
        assert.throws(() => browser.buildAuthorizeUrl({ clientId: 'x' }), TypeError);
    }],

    ['readCallback checks state and surfaces errors', async () => {
        assert.deepEqual(browser.readCallback('https://a/cb?code=abc&state=s1', { expectedState: 's1' }), { code: 'abc', state: 's1' });
        assert.throws(() => browser.readCallback('https://a/cb?code=abc&state=evil', { expectedState: 's1' }), { code: 'oauth.state_mismatch' });
        assert.throws(() => browser.readCallback('/cb?error=login_required&state=s1'), { code: 'oauth.login_required' });
        assert.throws(() => browser.readCallback('/cb?state=s1'), { code: 'oauth.missing_code' });
    }],

    ['server callback exchanges the code with the verifier (mock Network checks PKCE)', async () => {
        const platform = createMockPlatform({ clients: { demo: { secret: 'demo-secret' } }, users: [{ username: 'ana' }] });
        const user = [...platform.state.users.values()][0];
        const redirectUri = 'https://demo.example/cb';
        const { codeVerifier, codeChallenge } = await browser.createPkcePair();

        const code = platform.authorize({ clientId: 'demo', redirectUri, subjectId: user.subject_id, codeChallenge });
        const tokens = await exchangeCode({ fetch: platform.fetch, clientId: 'demo', clientSecret: 'demo-secret', code, redirectUri, codeVerifier });
        assert.ok(tokens.access_token && tokens.refresh_token);
        const claims = await verifyUserToken(tokens.access_token, { jwks: platform.keys.jwks, issuer: platform.issuer, audience: 'openvibe.network' });
        assert.equal(claims.subject_id, user.subject_id);

        await assert.rejects(exchangeCode({ fetch: platform.fetch, clientId: 'demo', clientSecret: 'demo-secret', code, redirectUri, codeVerifier }), { code: 'invalid_grant' });
        const code2 = platform.authorize({ clientId: 'demo', redirectUri, subjectId: user.subject_id, codeChallenge });
        await assert.rejects(exchangeCode({ fetch: platform.fetch, clientId: 'demo', clientSecret: 'demo-secret', code: code2, redirectUri, codeVerifier: browser.createCodeVerifier() }), (err) => err.code === 'invalid_grant' && /PKCE/.test(err.detail));

        const refreshed = await refreshUserToken({ fetch: platform.fetch, clientId: 'demo', clientSecret: 'demo-secret', refreshToken: tokens.refresh_token });
        assert.ok(refreshed.access_token);
        await assert.rejects(refreshUserToken({ fetch: platform.fetch, clientId: 'demo', clientSecret: 'demo-secret', refreshToken: tokens.refresh_token }), { code: 'invalid_grant' });
    }],
]);
