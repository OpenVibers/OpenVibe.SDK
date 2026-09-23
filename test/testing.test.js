'use strict';
/**
 * Acceptance (README): an external app authenticates, discovers Media from the registry and
 * uploads an object with only the SDK and a capability grant; plus user modules against the mock.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const sdk = require('..');
const { createMockPlatform } = require('../src/testing');

run([
    ['client credentials -> discovery -> Media upload with media.object.upload', async () => {
        const platform = createMockPlatform({
            clients: { 'demo-app': { secret: 'demo-secret', grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: ['demo'] }] } },
            mediaApps: { demo: {} },
        });
        const tokens = sdk.auth.createServiceTokenClient({ clientId: 'demo-app', clientSecret: 'demo-secret', fetch: platform.fetch });
        const client = sdk.createClient({ fetch: platform.fetch, tokenProvider: tokens, strictContracts: true });

        const d = await client.discover();
        assert.equal(d.origins.media, 'https://openvibe.media');
        assert.equal(await client.supports('media'), true);
        const media = sdk.media.createMediaClient(client, { app: 'demo' });
        const file = await media.upload(Buffer.from('hello platform'), { filename: 'hello.txt', contentType: 'text/plain' });
        assert.match(file.key, /^[0-9a-f]{12}-hello\.txt$/);
        assert.equal(file.public_url, `https://openvibe.media/f/${file.key}`);
        assert.equal(platform.state.files.size, 1);
        assert.equal(platform.stats.tokenRequests, 1);

        const again = await media.upload(Buffer.from('hello platform'), { filename: 'hello.txt' });
        assert.equal(again.deduplicated, true);
        assert.equal(platform.stats.tokenRequests, 1, 'token reused');

        const other = sdk.media.createMediaClient(client, { app: 'someone-else' });
        await assert.rejects(other.upload('x'), (err) => err.status === 404 || err.code === 'capability.namespace_denied');
        await assert.rejects(media.files.list(), { status: 401 }, 'a service token only uploads; listing needs the app key');
    }],

    ['user modules with a Network user token', async () => {
        const platform = createMockPlatform({ users: [{ username: 'ana' }] });
        const ana = [...platform.state.users.values()][0];
        const client = sdk.createClient({ fetch: platform.fetch, token: platform.signUserToken(ana) });
        const modules = sdk.modules.createModulesClient(client);
        assert.equal(await modules.get('demo.prefs'), null);
        await modules.update('demo.prefs', (d) => ({ ...d, theme: 'blue', secret: 1 }));
        const rec = await modules.update('demo.prefs', (d) => ({ ...d, theme: 'violet' }));
        assert.equal(rec.revision, 2);
        assert.deepEqual((await modules.publicGet('demo.prefs', ana.subject_id)).data, { theme: 'violet' });
        assert.equal((await modules.list()).modules.length, 1);
    }],

    ['the registry client works against the mock', async () => {
        const platform = createMockPlatform({ capabilities: [{ id: 'media.object.upload', owner: 'media', version: '1.0.0', status: 'active', visibility: 'first-party', permissions: [], resourceConstraints: ['namespace'], quotaClass: 'media', events: [] }] });
        const registry = sdk.registry.createRegistryClient(sdk.createClient({ fetch: platform.fetch }));
        assert.equal((await registry.domain('openvibe.media')).service.id, 'media');
        assert.equal((await registry.capabilities({ owner: 'media' }))[0].id, 'media.object.upload');
        assert.equal((await registry.namespaces())[0].namespace, 'demo.prefs');
    }],
]);
