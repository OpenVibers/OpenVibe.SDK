'use strict';
/** Discovery (/.well-known/openvibe) caching and version negotiation; registry routes. */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run, sleep } = require('./helpers');
const { createClient } = require('../src/core');
const { createRegistryClient } = require('../src/registry');

async function networkStub({ version = '0.6.0', mediaOrigin } = {}) {
    let v = version;
    const srv = await stubServer(async (req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/.well-known/openvibe') {
            await sleep(10);
            return send(res, 200, {
                name: 'OpenVibe', issuer: 'https://openvibe.network', token_endpoint: 'https://openvibe.network/oauth/token', jwks_uri: 'https://openvibe.network/api/.well-known/jwks',
                registry: 'https://openvibe.network/api/v1/registry', contracts: { package: 'openvibe-contracts', version: v },
                services: [{ id: 'network', status: 'stable', origin: 'https://openvibe.network' }, { id: 'media', status: 'beta', origin: mediaOrigin || 'https://openvibe.media' }, { id: 'sdk', status: 'placeholder', origin: null }],
            });
        }
        if (u.pathname === '/api/v1/registry/services') return send(res, 200, { services: [{ id: 'media', status: u.searchParams.get('status') || 'beta' }], contracts_version: v });
        if (u.pathname === '/api/v1/registry/services/media') return send(res, 200, { id: 'media', capability_details: [] });
        if (u.pathname.startsWith('/api/v1/registry/services/')) return problem(res, 404, 'registry.unknown_service', 'no service');
        if (u.pathname === '/api/v1/registry/capabilities') return send(res, 200, { capabilities: [{ id: 'media.object.upload', owner: u.searchParams.get('owner') }] });
        if (u.pathname === '/api/v1/registry/namespaces') return send(res, 200, { namespaces: [{ namespace: 'chat.preferences' }] });
        if (u.pathname === '/api/v1/registry/contracts') return send(res, 200, { version: v, contracts: [] });
        if (u.pathname === '/api/v1/registry/domains/openvibe.media') return send(res, 200, { domain: 'openvibe.media', service: { id: 'media' } });
        if (u.pathname.startsWith('/api/v1/registry/domains/')) return problem(res, 404, 'registry.unknown_domain', 'nope');
        if (u.pathname === '/api/v1/registry/topics') return send(res, 200, { topics: [] });
        if (u.pathname === '/api/v1/media/files') return send(res, 200, { served: 'media' });
        return send(res, 404, { error: 'Not found' });
    });
    return { srv, setVersion: (x) => { v = x; }, discoveries: () => srv.requests.filter((r) => r.url === '/.well-known/openvibe').length };
}

run([
    ['discover() caches the descriptor; concurrent callers share one fetch', async () => {
        const n = await networkStub();
        const client = createClient({ network: n.srv.url });
        const [a, b, c] = await Promise.all([client.discover(), client.discover(), client.discover()]);
        assert.equal(a, b);
        assert.equal(b, c);
        assert.equal(await client.discover(), a);
        assert.equal(n.discoveries(), 1);
        assert.equal(a.contractsVersion, '0.6.0');
        assert.equal(a.compatible, true);
        assert.equal(a.origins.media, 'https://openvibe.media');
        assert.equal(a.tokenEndpoint, 'https://openvibe.network/oauth/token');
        assert.equal(client.discovery(), a);
        await client.discover({ force: true });
        assert.equal(n.discoveries(), 2);
        assert.equal(n.srv.requests[0].headers.authorization, undefined, 'discovery is anonymous');
        await n.srv.close();
    }],

    ['the cache expires after discoveryTtlMs', async () => {
        const n = await networkStub();
        const client = createClient({ network: n.srv.url, discoveryTtlMs: 40 });
        await client.discover();
        await client.discover();
        await sleep(60);
        await client.discover();
        assert.equal(n.discoveries(), 2);
        await n.srv.close();
    }],

    ['service origins come from discovery unless baseUrls say otherwise', async () => {
        const n = await networkStub();
        const self = await networkStub({ mediaOrigin: 'placeholder' });
        const client = createClient({ network: n.srv.url });
        assert.equal(await client.origin('media'), 'https://openvibe.media');
        const pinned = createClient({ network: n.srv.url, baseUrls: { media: self.srv.url } });
        assert.deepEqual(await pinned.json({ service: 'media', path: '/api/v1/media/files' }), { served: 'media' });
        assert.equal(n.discoveries(), 1, 'the pinned client never needed discovery');
        await assert.rejects(client.origin('sdk'), { code: 'sdk.unknown_service' });
        assert.equal(await client.supports('media'), true);
        assert.equal(await client.supports('sdk'), false);
        assert.equal(await client.supports('ghost'), false);
        await n.srv.close();
        await self.srv.close();
    }],

    ['version negotiation: warn by default, throw when strict', async () => {
        const n = await networkStub({ version: '1.2.0' });
        const warnings = [];
        const client = createClient({ network: n.srv.url, onWarning: (m) => warnings.push(m) });
        const d = await client.discover();
        assert.equal(d.compatible, false);
        await client.discover({ force: true });
        assert.equal(warnings.length, 1, 'warned once');
        assert.match(warnings[0], /1\.2\.0/);
        const strict = createClient({ network: n.srv.url, strictContracts: true });
        await assert.rejects(strict.discover(), { code: 'sdk.incompatible_contracts' });
        const wide = createClient({ network: n.srv.url, strictContracts: true, contractsRange: '^1.0.0' });
        assert.equal((await wide.discover()).compatible, true);
        await n.srv.close();
    }],

    ['registry methods hit /api/v1/registry and map 404 to null', async () => {
        const n = await networkStub();
        const registry = createRegistryClient(createClient({ network: n.srv.url }));
        assert.deepEqual(await registry.services({ status: 'alpha' }), [{ id: 'media', status: 'alpha' }]);
        assert.equal((await registry.service('media')).id, 'media');
        assert.equal(await registry.service('ghost'), null);
        assert.deepEqual(await registry.capabilities({ owner: 'media' }), [{ id: 'media.object.upload', owner: 'media' }]);
        assert.deepEqual(await registry.namespaces(), [{ namespace: 'chat.preferences' }]);
        assert.equal((await registry.contracts()).version, '0.6.0');
        assert.equal((await registry.domain('OpenVibe.Media')).service.id, 'media');
        assert.equal(await registry.domain('nowhere.example'), null);
        assert.deepEqual(await registry.topics(), []);
        assert.equal((await registry.descriptor()).contractsVersion, '0.6.0');
        assert.ok(n.srv.requests.every((r) => !r.headers.authorization));
        await n.srv.close();
    }],
]);
