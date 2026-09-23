'use strict';
/**
 * Mock platform services as production answers them: Media's developer-project tenants (read vs
 * upload capabilities, sandbox tenant apart from production, signed-only sandbox files, quotas,
 * first-party tenants), and Tools jobs on the img., audio. and docs. satellites.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createMediaClient } = require('../src/media');
const { createJobsClient } = require('../src/jobs');
const { createMockPlatform, DEFAULT_TOOLS_SATELLITES } = require('../src/testing');

const PRJ = 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TA';
const UP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T1';      // production, upload only
const RD = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T2';      // production, read only
const SBX = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T3';     // sandbox, read + upload

function setup(extra = {}) {
    const platform = createMockPlatform({
        mediaApps: { demo: { apiKey: 'demo-key' }, other: { apiKey: 'other-key' } },
        clients: { svc: { secret: 's', grants: [{ capability: 'media.object.read', audience: 'openvibe.media', namespaces: ['demo'] }] } },
        apps: {
            [UP]: { project: PRJ, env: 'production', secret: 'up', grants: ['media.object.upload'] },
            [RD]: { project: PRJ, env: 'production', secret: 'rd', grants: ['media.object.read'] },
            [SBX]: { project: PRJ, env: 'sandbox', secret: 'sbx', grants: ['media.object.read', 'media.object.upload'] },
        },
        ...extra,
    });
    const clientFor = (id, secret) => createClient({ fetch: platform.fetch, retries: 0, tokenProvider: createServiceTokenClient({ clientId: id, clientSecret: secret, fetch: platform.fetch }) });
    const mediaFor = (id, secret, app = PRJ) => createMediaClient(clientFor(id, secret), { app });
    return { platform, clientFor, mediaFor };
}

run([
    ['Media: media.object.read lists and gets, media.object.upload uploads and deletes', async () => {
        const { platform, mediaFor } = setup();
        const up = mediaFor(UP, 'up');
        const rd = mediaFor(RD, 'rd');
        const f = await up.upload('hello', { filename: 'a.txt' });
        await assert.rejects(up.files.list(), { status: 403, code: 'capability.denied' });
        await assert.rejects(up.files.get(f.key), { status: 403, code: 'capability.denied' });
        const list = await rd.files.list();
        assert.deepEqual(list.files.map((x) => x.key), [f.key]);
        assert.equal(list.quota_bytes, 1024 * 1024 * 1024, 'production project tenant: 1 GB');
        assert.equal(list.used_bytes, 5);
        assert.equal((await rd.files.get(f.key)).sha256, f.sha256);
        assert.equal(await rd.files.get('nope'), null);
        await assert.rejects(rd.upload('x'), { status: 403, code: 'capability.denied' });
        await assert.rejects(rd.files.delete(f.key), { status: 403, code: 'capability.denied' });
        assert.equal(await up.files.delete(f.key), true);
        assert.equal(await up.files.delete(f.key), false);
        assert.equal((await rd.files.list()).files.length, 0);
        assert.equal((await platform.fetch(f.public_url)).status, 404, 'gone');
    }],

    ['Media: the sandbox tenant is <project>-sandbox, apart from production, and signed URLs only', async () => {
        const { platform, mediaFor } = setup();
        const prodFile = await mediaFor(UP, 'up').upload('prod', { filename: 'p.txt' });
        const sbx = mediaFor(SBX, 'sbx');
        const f = await sbx.upload('secret bytes', { filename: 'img.png', contentType: 'image/png' });
        assert.equal(f.app_id, `${PRJ}-sandbox`);
        assert.equal(f.sandbox, true);
        assert.equal(f.public_url, null);
        assert.equal(f.signed_url, f.url);
        assert.ok(platform.state.files.has(`${PRJ}-sandbox|${f.key}`));
        assert.equal(platform.state.mediaTenants.get(`${PRJ}-sandbox`).env, 'sandbox');

        const list = await sbx.files.list();
        assert.deepEqual(list.files.map((x) => x.key), [f.key], 'the sandbox app sees its tenant only');
        assert.equal(list.quota_bytes, 100 * 1024 * 1024, 'sandbox tenant: 100 MB');
        assert.equal(list.files[0].sandbox, true);
        assert.match(list.files[0].url, /\?exp=\d+&sig=/, 'every answer carries a fresh signed URL');
        assert.equal(await sbx.files.get(prodFile.key), null, 'production files do not exist for a sandbox app');
        assert.deepEqual((await mediaFor(RD, 'rd').files.list()).files.map((x) => x.key), [prodFile.key]);

        const served = await platform.fetch(f.signed_url);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('content-type'), 'image/png');
        assert.equal(served.headers.get('cache-control'), 'private, no-store');
        assert.equal(await served.text(), 'secret bytes');
        assert.equal((await platform.fetch(`${platform.origins.media}/f/${f.key}`)).status, 404);
        const u = new URL(f.signed_url);
        u.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 10));
        assert.equal((await platform.fetch(u)).status, 404, 'an expired (or re-signed) URL is refused');
        assert.equal((await platform.fetch(`${platform.origins.media}/f/${prodFile.key}`)).headers.get('cache-control'), 'public, max-age=86400');
        assert.equal(await sbx.files.delete(f.key), true);
    }],

    ['Media: tenant rules for app tokens, service tokens and app keys; quotas', async () => {
        const { platform, clientFor, mediaFor } = setup({ mediaQuotaMb: { sandbox: 0.00001 } });
        await assert.rejects(mediaFor(UP, 'up', 'demo').upload('x'), { status: 403, code: 'capability.namespace_denied' }, 'apps reach /<project_id>/ only');
        await assert.rejects(mediaFor(UP, 'up', 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TZ').upload('x'), { status: 403, code: 'capability.namespace_denied' });
        await assert.rejects(mediaFor(SBX, 'sbx', 'demo').files.list(), { status: 401, code: 'token.sandbox_refused' });
        await assert.rejects(mediaFor(SBX, 'sbx').upload('more than ten bytes'), { status: 413 });
        assert.ok((await mediaFor(SBX, 'sbx').upload('tiny')).key);

        const key = createMediaClient(createClient({ fetch: platform.fetch }), { app: 'demo', apiKey: 'demo-key', actingUserId: 7 });
        const mine = await key.upload('by seven');
        assert.equal(mine.user_id, 7);
        await assert.rejects(key.files.delete(mine.key, { actingUserId: 8 }), { status: 403 }, 'an acting user deletes only their files');
        await assert.rejects(createMediaClient(createClient({ fetch: platform.fetch }), { app: 'demo', apiKey: 'other-key' }).files.list(), { status: 403 });
        await assert.rejects(createMediaClient(createClient({ fetch: platform.fetch }), { app: PRJ, apiKey: 'demo-key' }).files.list(), { status: 404 }, 'project tenants are reached with app tokens only');

        const svc = createMediaClient(clientFor('svc', 's'), { app: 'demo' });
        assert.equal((await svc.files.list()).files.length, 1, 'a service token with media.object.read lists');
        await assert.rejects(svc.upload('x'), { status: 403, code: 'capability.denied' });
        await assert.rejects(createMediaClient(clientFor('svc', 's'), { app: 'other' }).files.list(), { status: 403, code: 'capability.namespace_denied' });
    }],

    ['Tools: the img., audio. and docs. satellites answer /api/v1/jobs, each with its own jobs', async () => {
        const platform = createMockPlatform({ jobs: { stepMs: 1 }, clients: { svc: { secret: 's', grants: [['tools.job.create', 'openvibe.tools'], ['tools.job.read', 'openvibe.tools']] } } });
        assert.deepEqual(platform.toolsOrigins, ['https://openvibe.tools', ...DEFAULT_TOOLS_SATELLITES]);
        const client = createClient({ fetch: platform.fetch, retries: 0, tokenProvider: createServiceTokenClient({ clientId: 'svc', clientSecret: 's', fetch: platform.fetch }) });
        const img = createJobsClient(client, { baseUrl: 'https://img.openvibe.tools' });
        const audio = createJobsClient(client, { baseUrl: 'https://audio.openvibe.tools' });
        const docs = createJobsClient(client, { baseUrl: 'https://docs.openvibe.tools' });
        const { job } = await img.submit({ type: 'img.process', input: { format: 'webp' } });
        assert.equal((await img.wait(job.id)).state, 'succeeded');
        assert.equal(await audio.get(job.id), null, 'a job lives on the satellite that created it');
        assert.ok((await docs.submit({ type: 'docs.convert', input: {} })).job.id);
        await assert.rejects(platform.fetch('https://video.openvibe.tools/api/v1/jobs'), TypeError);
        const only = createMockPlatform({ jobs: true, toolsSatellites: [] });
        assert.deepEqual(only.toolsOrigins, ['https://openvibe.tools']);
    }],
]);
