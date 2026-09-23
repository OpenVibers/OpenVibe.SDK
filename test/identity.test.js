'use strict';
/** Identity: subject resolution with a service token; 404 -> null; batches split at 500. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createIdentityClient } = require('../src/identity');
const { createMockPlatform } = require('../src/testing');

run([
    ['resolve by subject id or legacy id against the mock Network', async () => {
        const platform = createMockPlatform({
            clients: { community: { secret: 'c', grants: [['identity.subject.resolve', 'openvibe.network']] }, tools: { secret: 't', grants: [['media.object.upload', 'openvibe.media']] } },
            users: [{ id: 5, username: 'ana', legacy: [{ system: 'live', id: 900 }] }],
        });
        const ana = [...platform.state.users.values()][0];
        const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'community', clientSecret: 'c', fetch: platform.fetch }) });
        const identity = createIdentityClient(client);
        assert.equal((await identity.resolve({ subjectId: ana.subject_id })).username, 'ana');
        assert.deepEqual((await identity.resolve({ system: 'live', id: 900 })).subject, { type: 'user', id: ana.subject_id });
        assert.equal(await identity.resolve({ subjectId: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }), null);
        await assert.rejects(identity.resolve({}), TypeError);
        const batch = await identity.resolveBatch({ system: 'network', ids: [5, 6] });
        assert.equal(batch['5'].username, 'ana');
        assert.equal(batch['6'], null);

        const denied = createIdentityClient(createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'tools', clientSecret: 't', fetch: platform.fetch }) }));
        await assert.rejects(denied.resolve({ subjectId: ana.subject_id }), (err) => err.code === 'invalid_scope' || err.status === 403, 'no grant for openvibe.network');
    }],

    ['resolveBatch splits into calls of 500 and dedupes ids', async () => {
        const srv = await stubServer((req, res, body) => {
            const b = JSON.parse(body.toString());
            send(res, 200, { results: Object.fromEntries(b.subject_ids.map((id) => [id, { subject: { type: 'user', id } }])) });
        });
        const identity = createIdentityClient(createClient({ baseUrls: { network: srv.url }, token: 'svc' }));
        const ids = Array.from({ length: 1201 }, (_, i) => `usr_${String(i).padStart(26, '0')}`);
        const out = await identity.resolveBatch({ subjectIds: [...ids, ids[0]] });
        assert.equal(Object.keys(out).length, 1201);
        assert.deepEqual(srv.requests.map((r) => JSON.parse(r.body.toString()).subject_ids.length), [500, 500, 201]);
        assert.ok(srv.requests.every((r) => r.url === '/internal/identity/resolve-batch' && r.headers.authorization === 'Bearer svc'));
        await assert.rejects(identity.resolveBatch({ ids: [1] }), TypeError);
        await srv.close();
    }],
]);
