'use strict';
/**
 * Developer apps (Network ADR-014) end to end against the mock platform: authorize URL with an
 * audience, /oauth/authorize, exchangeCode for public and confidential apps (no refresh token),
 * verifyAppToken (project_id, env, on_behalf_of, sandbox refusal), client credentials with
 * getTokenInfo(), and a project-scoped Media upload.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createClient } = require('../src/core');
const auth = require('../src/auth');
const { createMediaClient } = require('../src/media');
const { createMockPlatform } = require('../src/testing');

const PUBLIC_APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR';
const SERVER_APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TS';
const PRJ = 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TA';
const REDIRECT = 'http://localhost:3001/callback';

function setup(extra = {}) {
    const platform = createMockPlatform({
        users: [{ username: 'ana' }, { username: 'bo' }],
        apps: {
            [PUBLIC_APP]: { project: PRJ, type: 'public', env: 'sandbox', redirectUris: [REDIRECT], grants: ['media.object.read', 'media.object.upload'] },
            [SERVER_APP]: { project: PRJ, type: 'confidential', env: 'production', secret: 'ovsec_server', redirectUris: [REDIRECT], grants: ['media.object.upload', 'tools.job.create'] },
        },
        ...extra,
    });
    const [ana, bo] = [...platform.state.users.values()];
    return { platform, ana, bo };
}

/** Browser half + Network: returns { code, codeVerifier } after /oauth/authorize redirects back. */
async function signIn(platform, opts) {
    const { url, state, codeVerifier } = await auth.startAuthorization({ clientId: PUBLIC_APP, redirectUri: REDIRECT, ...opts });
    const res = await platform.fetch(url);
    assert.equal(res.status, 302);
    const back = res.headers.get('location');
    return { back, state, codeVerifier, ...(new URL(back).searchParams.get('code') ? auth.readCallback(back, { expectedState: state }) : {}) };
}

run([
    ['buildAuthorizeUrl: audience + capability scope for apps, profile theme only for first-party', async () => {
        const app = new URL(auth.buildAuthorizeUrl({ clientId: PUBLIC_APP, redirectUri: REDIRECT, audience: 'openvibe.media', scope: ['media.object.read', 'media.object.upload'], codeChallenge: 'x'.repeat(43) }));
        assert.equal(app.searchParams.get('audience'), 'openvibe.media');
        assert.equal(app.searchParams.get('scope'), 'media.object.read media.object.upload');
        const noScope = new URL(auth.buildAuthorizeUrl({ clientId: PUBLIC_APP, redirectUri: REDIRECT, audience: 'openvibe.media' }));
        assert.equal(noScope.searchParams.get('scope'), null, 'no first-party default when an audience is given');
        const firstParty = new URL(auth.buildAuthorizeUrl({ clientId: 'live', redirectUri: REDIRECT }));
        assert.equal(firstParty.searchParams.get('scope'), 'profile theme');
        assert.equal(firstParty.searchParams.get('audience'), null);
    }],

    ['public app: /oauth/authorize -> code -> exchange without a secret -> app token for the person', async () => {
        const { platform, ana } = setup({ acceptSandbox: ['openvibe.media'] });
        platform.setAuthorization({ subjectId: ana.subject_id });
        const { code, codeVerifier } = await signIn(platform, { audience: 'openvibe.media', scope: ['media.object.read'] });
        const t = await auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code, codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.media' });
        assert.equal(t.refresh_token, undefined, 'apps get no refresh token');
        assert.equal(t.expires_in, 300);
        assert.equal(t.scope, 'media.object.read', 'the authorized scope limits the token');
        const claims = await auth.verifyAppToken(t.access_token, { jwks: platform.keys.jwks, issuer: platform.issuer, audience: 'openvibe.media', acceptSandbox: true });
        assert.equal(claims.sub, `app:${PUBLIC_APP}`);
        assert.equal(claims.actor_type, 'app');
        assert.equal(claims.project_id, PRJ);
        assert.deepEqual(claims.ns, [PRJ]);
        assert.equal(claims.env, 'sandbox');
        assert.equal(claims.on_behalf_of, ana.subject_id);
        assert.deepEqual(claims.cap, ['media.object.read']);
        const tokenCall = platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token')).at(-1);
        assert.ok(tokenCall, 'the exchange hit the token endpoint');
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code, codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.media' }), { code: 'invalid_grant' }, 'codes work once');
    }],

    ['exchangeCode refuses to run without what apps need; Network-side refusals come back as codes', async () => {
        const { platform } = setup();
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: 'c', redirectUri: REDIRECT, audience: 'openvibe.media' }), TypeError, 'public: verifier required');
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT }), /audience/, 'apps: audience required');
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: SERVER_APP, clientSecret: 'ovsec_server', code: 'c', redirectUri: REDIRECT, audience: 'openvibe.media' }), /PKCE/, 'apps always use PKCE');

        // The code is bound to the audience it was authorized for.
        let s = await signIn(platform, { audience: 'openvibe.media', scope: ['media.object.read'] });
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: s.code, codeVerifier: s.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.tools' }), (e) => e.code === 'invalid_grant' && /openvibe\.media/.test(e.detail));
        // The exchange may narrow, never widen.
        s = await signIn(platform, { audience: 'openvibe.media', scope: ['media.object.read'] });
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: s.code, codeVerifier: s.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.media', scope: ['media.object.upload'] }), { code: 'invalid_scope' });
        // A public app that sends a secret, and a wrong verifier (which burns the code).
        s = await signIn(platform, { audience: 'openvibe.media' });
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, clientSecret: 'nope', code: s.code, codeVerifier: s.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.media' }), { code: 'invalid_client' });
        s = await signIn(platform, { audience: 'openvibe.media' });
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: s.code, codeVerifier: auth.createCodeVerifier(), redirectUri: REDIRECT, audience: 'openvibe.media' }), (e) => e.code === 'invalid_grant' && /PKCE/.test(e.detail));
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: PUBLIC_APP, code: s.code, codeVerifier: s.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.media' }), { code: 'invalid_grant' }, 'burnt');
    }],

    ['/oauth/authorize: prompt=none, declined consent, unknown redirect, missing PKCE, sandbox membership', async () => {
        const { platform, ana, bo } = setup();
        const none = await signIn(platform, { audience: 'openvibe.media', prompt: 'none' });
        assert.throws(() => auth.readCallback(none.back), { code: 'oauth.interaction_required' });
        platform.setAuthorization({ decision: 'deny' });
        const denied = await signIn(platform, { audience: 'openvibe.media' });
        assert.throws(() => auth.readCallback(denied.back), { code: 'oauth.access_denied' });
        platform.setAuthorization({ decision: 'allow' });
        const bad = await platform.fetch(auth.buildAuthorizeUrl({ clientId: PUBLIC_APP, redirectUri: 'https://evil.example/cb', codeChallenge: 'x'.repeat(43) }));
        assert.equal(bad.status, 400, 'never redirects to an unregistered URI');
        const noPkce = await platform.fetch(auth.buildAuthorizeUrl({ clientId: PUBLIC_APP, redirectUri: REDIRECT, audience: 'openvibe.media' }));
        assert.equal(noPkce.status, 400);

        // A project with members: only they may authorize its sandbox app.
        const m = createMockPlatform({
            users: [ana, bo],
            projects: { [PRJ]: { owner: ana.subject_id } },
            apps: { [PUBLIC_APP]: { project: PRJ, type: 'public', redirectUris: [REDIRECT], grants: ['media.object.read'] } },
        });
        m.setAuthorization({ subjectId: bo.subject_id });
        const outsider = await signIn(m, { audience: 'openvibe.media' });
        assert.throws(() => auth.readCallback(outsider.back), { code: 'oauth.access_denied' });
        m.setAuthorization({ subjectId: ana.subject_id });
        assert.ok((await signIn(m, { audience: 'openvibe.media' })).code);
        assert.throws(() => m.authorize({ clientId: PUBLIC_APP, redirectUri: REDIRECT, subjectId: ana.subject_id }), /PKCE/, 'the helper checks PKCE for apps too');
    }],

    ['confidential app code flow needs its secret too; first-party sign-in keeps its refresh token', async () => {
        const { platform, bo } = setup();
        platform.setAuthorization({ subjectId: bo.subject_id });
        const start = await auth.startAuthorization({ clientId: SERVER_APP, redirectUri: REDIRECT, audience: 'openvibe.tools', scope: 'tools.job.create' });
        const { code } = auth.readCallback((await platform.fetch(start.url)).headers.get('location'), { expectedState: start.state });
        await assert.rejects(auth.exchangeCode({ fetch: platform.fetch, clientId: SERVER_APP, code, codeVerifier: start.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.tools' }), { code: 'invalid_client' });
        const start2 = await auth.startAuthorization({ clientId: SERVER_APP, redirectUri: REDIRECT, audience: 'openvibe.tools', scope: 'tools.job.create' });
        const code2 = auth.readCallback((await platform.fetch(start2.url)).headers.get('location')).code;
        const t = await auth.exchangeCode({ fetch: platform.fetch, clientId: SERVER_APP, clientSecret: 'ovsec_server', code: code2, codeVerifier: start2.codeVerifier, redirectUri: REDIRECT, audience: 'openvibe.tools' });
        const claims = await auth.verifyAppToken(t.access_token, { jwks: platform.keys.jwks, audience: 'openvibe.tools' });
        assert.equal(claims.on_behalf_of, bo.subject_id);
        assert.equal(claims.env, 'production');

        platform.addClient('live', { secret: 'live-secret', redirectUris: ['https://openvibe.live/cb'] });
        const fp = await auth.startAuthorization({ clientId: 'live', redirectUri: 'https://openvibe.live/cb' });
        const back = (await platform.fetch(fp.url)).headers.get('location');
        const user = await auth.exchangeCode({ fetch: platform.fetch, clientId: 'live', clientSecret: 'live-secret', code: auth.readCallback(back, { expectedState: fp.state }).code, codeVerifier: fp.codeVerifier, redirectUri: 'https://openvibe.live/cb' });
        assert.ok(user.refresh_token, 'first-party user tokens still refresh');
        assert.equal((await auth.verifyUserToken(user.access_token, { jwks: platform.keys.jwks })).subject_id, bo.subject_id);
    }],

    ['verifyAppToken: audience required, user tokens are not app tokens, sandbox refused unless accepted', async () => {
        const { platform, ana } = setup();
        const jwks = platform.keys.jwks;
        const sandbox = platform.signAppToken(PUBLIC_APP, { audience: 'openvibe.media', capabilities: ['media.object.read'] });
        await assert.rejects(auth.verifyAppToken(sandbox, { jwks }), TypeError);
        await assert.rejects(auth.verifyAppToken(sandbox, { jwks, audience: 'openvibe.media' }), { code: 'token.sandbox_refused', status: 401 });
        assert.equal((await auth.verifyAppToken(sandbox, { jwks, audience: 'openvibe.media', acceptSandbox: true })).env, 'sandbox');
        await assert.rejects(auth.verifyAppToken(sandbox, { jwks, audience: 'openvibe.tools', acceptSandbox: true }), { code: 'token.wrong_audience' });
        const prod = platform.signAppToken(SERVER_APP, { audience: 'openvibe.media', capabilities: ['media.object.upload'] });
        assert.equal((await auth.verifyAppToken(prod, { jwks, audience: 'openvibe.media' })).env, 'production');
        await assert.rejects(auth.verifyAppToken(platform.signUserToken(ana), { jwks, audience: 'openvibe.media' }), { code: 'token.not_app' });
        await assert.rejects(auth.verifyAppToken(platform.signServiceToken('live', { audience: 'openvibe.media' }), { jwks, audience: 'openvibe.media' }), { code: 'token.not_app' });
        await assert.rejects(auth.verifyAppToken(platform.signAppToken(SERVER_APP, { audience: 'openvibe.media', projectId: 'prj_nope' }), { jwks, audience: 'openvibe.media' }), (e) => e.code === 'token.invalid_claims' && /project_id/.test(e.detail));
        await assert.rejects(auth.verifyUserToken(prod, { jwks }), { code: 'token.not_user' }, 'verifyUserToken stays for people');
    }],

    ['confidential app: client credentials, getTokenInfo() shows scope and (unverified) claims', async () => {
        const { platform } = setup();
        const tokens = auth.createServiceTokenClient({ clientId: SERVER_APP, clientSecret: 'ovsec_server', fetch: platform.fetch });
        const info = await tokens.getTokenInfo({ audience: 'openvibe.media' });
        assert.deepEqual(info.scope, ['media.object.upload']);
        assert.equal(info.audience, 'openvibe.media');
        assert.equal(info.tokenType, 'Bearer');
        assert.ok(Date.parse(info.expiresAt) > Date.now());
        assert.equal(info.unverifiedClaims.project_id, PRJ);
        assert.equal(info.unverifiedClaims.env, 'production');
        assert.equal(info.unverifiedClaims.on_behalf_of, undefined);
        assert.equal(info.accessToken, await tokens.getToken({ audience: 'openvibe.media' }), 'same cached token');
        assert.deepEqual(auth.unverifiedClaims(info.accessToken), info.unverifiedClaims);
        assert.equal(auth.decodeUnverified('nope'), null);
        assert.equal(auth.decodeUnverified(info.accessToken).header.alg, 'RS256');
        await assert.rejects(tokens.getToken({ audience: 'openvibe.events' }), { code: 'invalid_scope' }, 'no grant for that audience');
        await assert.rejects(auth.createServiceTokenClient({ clientId: PUBLIC_APP, clientSecret: 'x', fetch: platform.fetch }).getToken({ audience: 'openvibe.media' }), { code: 'unauthorized_client' }, 'public apps have no client credentials grant');
    }],

    ['Media: an app uploads into its project namespace; production and sandbox tenants stay apart', async () => {
        const { platform } = setup();
        const client = createClient({ fetch: platform.fetch, tokenProvider: auth.createServiceTokenClient({ clientId: SERVER_APP, clientSecret: 'ovsec_server', fetch: platform.fetch }) });
        const file = await createMediaClient(client, { app: PRJ }).upload('hello', { filename: 'a.txt' });
        assert.ok(platform.state.files.has(`${PRJ}|${file.key}`));
        assert.equal(file.app_id, PRJ);
        assert.equal(file.sandbox, undefined);
        assert.equal(file.url, `/f/${file.key}`);
        assert.equal(file.public_url, `https://openvibe.media/f/${file.key}`);
        assert.equal(await (await platform.fetch(file.public_url)).text(), 'hello', 'production files are public');
        await assert.rejects(createMediaClient(client, { app: 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TZ' }).upload('x'), { status: 403, code: 'capability.namespace_denied' });

        // Media accepts sandbox app tokens on the project's own tenant (and nowhere else).
        const sandboxApp = platform.addApp({ project: PRJ, env: 'sandbox', grants: ['media.object.upload'] });
        const sandboxClient = createClient({ fetch: platform.fetch, tokenProvider: auth.createServiceTokenClient({ clientId: sandboxApp.id, clientSecret: sandboxApp.secret, fetch: platform.fetch }) });
        const sbx = await createMediaClient(sandboxClient, { app: PRJ }).upload('hello', { filename: 'a.txt' });
        assert.equal(sbx.app_id, `${PRJ}-sandbox`);
        assert.equal(sbx.sandbox, true);
        assert.notEqual(sbx.key, file.key, 'tenant-tagged keys never collide across tenants');
        assert.match(sbx.url, /^https:\/\/openvibe\.media\/f\/[^?]+\?exp=\d+&sig=[\w-]+$/);
        assert.ok(Date.parse(sbx.url_expires_at) > Date.now());
        assert.equal(sbx.public_url, null);
        assert.equal(sbx.signed_url, sbx.url);
        assert.equal((await platform.fetch(`https://openvibe.media/f/${sbx.key}`)).status, 404, 'never served without a signature');
        assert.equal((await platform.fetch(sbx.url.replace(/sig=[\w-]+/, 'sig=forged'))).status, 404);
        assert.equal(await (await platform.fetch(sbx.signed_url)).text(), 'hello');
        await assert.rejects(createMediaClient(sandboxClient, { app: 'demo' }).upload('x'), { status: 401, code: 'token.sandbox_refused' });
        const limited = createMockPlatform({ sandboxAudiences: ['openvibe.tools'], apps: { [PUBLIC_APP]: { project: PRJ, secret: 's', type: 'confidential', grants: ['media.object.upload'] } } });
        await assert.rejects(auth.createServiceTokenClient({ clientId: PUBLIC_APP, clientSecret: 's', fetch: limited.fetch }).getToken({ audience: 'openvibe.media' }), { code: 'invalid_target' });
    }],
]);
