'use strict';
/**
 * openvibe-sdk/projects against the mock /api/v1/projects: the walkthrough (project -> app with a
 * shown-once secret -> grant -> app token), members and roles, credentials rotate/revoke, grants
 * approve/deny/revoke, allowance, audit; plus the request shapes and no-retry rules on a stub.
 */
const assert = require('node:assert/strict');
const { run, stubServer, send } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createProjectsClient } = require('../src/projects');
const { createMockPlatform, DEFAULT_APP_CATALOG } = require('../src/testing');

function setup(opts) {
    const platform = createMockPlatform({ users: [{ username: 'owner' }, { username: 'dev' }, { username: 'staff', role: 'admin' }, { username: 'stranger' }], ...opts });
    const [owner, dev, staff, stranger] = [...platform.state.users.values()];
    const as = (u) => createProjectsClient(createClient({ fetch: platform.fetch, token: platform.signUserToken(u) }));
    return { platform, owner, dev, staff, stranger, as };
}

run([
    ['walkthrough: project -> confidential app (secret once) -> grant -> a working app token', async () => {
        const { platform, as, owner } = setup();
        const projects = as(owner);
        assert.deepEqual((await projects.catalog()).map((c) => c.id).sort(), [...DEFAULT_APP_CATALOG].sort());
        const prj = await projects.create({ name: 'My first OpenVibe app' });
        assert.match(prj.id, /^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(prj.role, 'owner');
        assert.deepEqual(prj.environments, ['sandbox'], 'a new project is sandbox only');
        assert.equal((await projects.list()).length, 1);

        const app = await projects.apps.create(prj.id, { name: 'server', environment: 'sandbox', type: 'confidential', redirectUris: ['http://localhost:3009/callback'] });
        assert.match(app.id, /^app_/);
        assert.equal(app.client_id, app.id);
        assert.equal(app.credential.shown_once, true);
        const secret = app.credential.client_secret;
        assert.match(secret, /^ovsec_/);
        assert.equal((await projects.apps.get(prj.id, app.id)).credential, undefined, 'never shown again');
        assert.ok(!JSON.stringify(await projects.credentials.list(prj.id, app.id)).includes(secret));

        const g = await projects.grants.request(prj.id, app.id, 'media.object.upload');
        assert.equal(g.status, 'approved', 'owner + inside the allowance: approved at once');
        assert.equal(g.audience, 'openvibe.media');
        const tokens = createServiceTokenClient({ clientId: app.id, clientSecret: secret, fetch: platform.fetch });
        const info = await tokens.getTokenInfo({ audience: 'openvibe.media' });
        assert.deepEqual(info.scope, ['media.object.upload']);
        assert.equal(info.unverifiedClaims.project_id, prj.id);
        assert.equal(info.unverifiedClaims.env, 'sandbox');

        // Rotate: the new secret works, the old one keeps working during the overlap; revoke ends it.
        const rotated = await projects.credentials.rotate(prj.id, app.id, { overlapSeconds: 3600 });
        assert.notEqual(rotated.credential.client_secret, secret);
        assert.equal(rotated.previous.length, 1);
        assert.ok(await createServiceTokenClient({ clientId: app.id, clientSecret: rotated.credential.client_secret, fetch: platform.fetch }).getToken({ audience: 'openvibe.media' }));
        const creds = await projects.credentials.list(prj.id, app.id);
        assert.deepEqual(creds.map((c) => c.state).sort(), ['active', 'expiring']);
        const old = creds.find((c) => c.state === 'expiring');
        assert.equal((await projects.credentials.revoke(prj.id, app.id, old.id)).state, 'revoked');
        await assert.rejects(createServiceTokenClient({ clientId: app.id, clientSecret: secret, fetch: platform.fetch }).getToken({ audience: 'openvibe.media' }), { code: 'invalid_client' });

        // Revoking the grant takes the capability out of new tokens; revoking the app stops tokens.
        await projects.grants.revoke(prj.id, app.id, 'media.object.upload');
        const fresh = createServiceTokenClient({ clientId: app.id, clientSecret: rotated.credential.client_secret, fetch: platform.fetch });
        await assert.rejects(fresh.getToken({ audience: 'openvibe.media' }), { code: 'invalid_scope' });
        assert.ok((await projects.apps.revoke(prj.id, app.id)).revoked_at);
        await assert.rejects(fresh.getToken({ audience: 'openvibe.media' }), { code: 'invalid_client' });
        const actions = [];
        for await (const e of projects.iterateAudit(prj.id, { pageSize: 2 })) actions.push(e.action);
        assert.deepEqual(actions.slice(0, 3), ['app.revoked', 'grant.revoked', 'credential.revoked'], 'newest first, across pages');
        assert.ok(actions.includes('project.created'));
        assert.ok(!JSON.stringify(await projects.audit(prj.id, { limit: 200 })).includes('ovsec_'), 'no secrets in the audit');
    }],

    ['roles: non-members see 404, developers request, admins approve inside the allowance, staff set it', async () => {
        const { as, owner, dev, staff, stranger } = setup();
        const prj = await as(owner).create({ name: 'team' });
        assert.equal(await as(stranger).get(prj.id), null, 'non-members: 404, existence not disclosed');
        await as(owner).members.add(prj.id, { username: 'dev', role: 'developer' });
        assert.equal((await as(owner).members.list(prj.id)).length, 2);
        const app = await as(dev).apps.create(prj.id, { name: 'web', type: 'public', redirectUris: ['http://localhost:3001/callback'] });
        assert.equal(app.credential, undefined, 'public apps have no secret');
        await assert.rejects(as(dev).apps.create(prj.id, { name: 'prod', environment: 'production' }), { status: 403 });
        const req = await as(dev).grants.request(prj.id, app.id, 'tools.job.read');
        assert.equal(req.status, 'requested', 'a developer request waits');
        await assert.rejects(as(dev).grants.approve(prj.id, app.id, 'tools.job.read'), { status: 403 });
        await assert.rejects(as(dev).grants.request(prj.id, app.id, 'events.event.read'), { status: 403, code: 'grant.not_grantable' });

        const shrunk = await as(staff).setAllowance(prj.id, ['media.object.read']);
        assert.deepEqual(shrunk.trimmed, [{ app_id: app.id, capability: 'tools.job.read', to: 'denied' }], 'shrinking the allowance denies pending requests outside it');
        await assert.rejects(as(owner).grants.approve(prj.id, app.id, 'tools.job.read'), { status: 403, code: 'grant.beyond_allowance' });
        await as(dev).grants.request(prj.id, app.id, 'media.object.read');
        assert.equal((await as(owner).grants.deny(prj.id, app.id, 'media.object.read')).status, 'denied');
        await as(dev).grants.request(prj.id, app.id, 'media.object.read');
        assert.equal((await as(owner).grants.approve(prj.id, app.id, 'media.object.read')).status, 'approved');
        assert.deepEqual((await as(dev).apps.get(prj.id, app.id)).grants, ['media.object.read']);
        await assert.rejects(as(owner).setAllowance(prj.id, []), { status: 403 }, 'only staff set the allowance');
        await as(staff).setEnvironmentPolicy(prj.id, 'sandbox+production');
        assert.deepEqual((await as(owner).get(prj.id)).environments, ['sandbox', 'production']);
        assert.equal((await as(owner).apps.create(prj.id, { name: 'prod', environment: 'production' })).environment, 'production');
        assert.equal((await as(staff).list({ all: true })).length, 1);

        await as(dev).members.remove(prj.id, dev.subject_id);          // leave
        assert.equal(await as(dev).get(prj.id), null);
        await assert.rejects(as(owner).members.remove(prj.id, owner.subject_id), { code: 'member.owner' });
        await as(owner).archive(prj.id);
        assert.ok((await as(owner).get(prj.id)).archived_at);
    }],

    ['only user tokens: service and app tokens get 401', async () => {
        const { platform, owner } = setup();
        const svc = createProjectsClient(createClient({ fetch: platform.fetch, token: platform.signServiceToken('live', { audience: 'openvibe.network' }) }));
        await assert.rejects(svc.list(), { status: 401, code: 'auth.invalid' });
        await assert.rejects(createProjectsClient(createClient({ fetch: platform.fetch })).list(), { status: 401, code: 'auth.required' });
        assert.ok(Array.isArray(await createProjectsClient(createClient({ fetch: platform.fetch, token: platform.signUserToken(owner) })).list()));
    }],

    ['request shapes, and calls that mint secrets or are not deduped are never retried', async () => {
        const srv = await stubServer((req, res) => send(res, 503, { code: 'network.unavailable', status: 503 }));
        const projects = createProjectsClient(createClient({ baseUrls: { network: srv.url }, token: 'user-jwt', retryDelayMs: 1 }));
        await assert.rejects(projects.apps.create('prj_1', { name: 'a', redirectUris: ['https://a.example/cb'] }), { status: 503 });
        await assert.rejects(projects.credentials.rotate('prj_1', 'app_1', { overlapSeconds: 0 }), { status: 503 });
        await assert.rejects(projects.create({ name: 'x' }), { status: 503 });
        assert.equal(srv.requests.length, 3, 'one attempt each');
        const [create, rotate] = srv.requests;
        assert.equal(create.url, '/api/v1/projects/prj_1/apps');
        assert.deepEqual(JSON.parse(create.body), { name: 'a', environment: 'sandbox', type: 'confidential', redirect_uris: ['https://a.example/cb'] });
        assert.equal(create.headers['idempotency-key'], undefined);
        assert.equal(rotate.url, '/api/v1/projects/prj_1/apps/app_1/credentials/rotate');
        assert.deepEqual(JSON.parse(rotate.body), { overlap_seconds: 0 });
        assert.equal(create.headers.authorization, 'Bearer user-jwt');
        await assert.rejects(projects.list(), { status: 503 });
        assert.equal(srv.requests.length, 3 + 3, 'reads are retried (2 retries)');
        await srv.close();
    }],
]);
