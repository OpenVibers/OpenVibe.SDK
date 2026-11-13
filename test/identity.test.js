'use strict';
/** Identity: subject resolution with a service token; 404 -> null; batches split at 500. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createIdentityClient, createAccountEmailsClient, createViewerClient } = require('../src/identity');
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

    ['verified email check asks Network for one subject and address only', async () => {
        const srv = await stubServer((req, res, body) => {
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/api/v1/identity/emails/verified-check');
            assert.deepEqual(JSON.parse(body.toString()), { subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', email: 'ana@example.test' });
            send(res, 200, { verified: true });
        });
        const identity = createIdentityClient(createClient({ baseUrls: { network: srv.url }, token: 'svc' }));
        assert.equal(await identity.isEmailVerified({ subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', email: 'ana@example.test' }), true);
        await assert.rejects(identity.isEmailVerified({ email: 'ana@example.test' }), TypeError);
        await srv.close();
    }],

    ["account email helpers use the signed-in person's Network API", async () => {
        const srv = await stubServer((req, res) => send(res, 200, { ok: true, emails: [] }));
        const emails = createAccountEmailsClient({ networkUrl: srv.url, getToken: () => 'person-token' });
        await emails.list();
        await emails.add('person@example.test');
        await emails.verify('email-id');
        await emails.makePrimary('email-id');
        await emails.remove('email-id');
        assert.deepEqual(srv.requests.map((r) => [r.method, r.url]), [
            ['GET', '/api/v1/me/emails'], ['POST', '/api/v1/me/emails'], ['POST', '/api/v1/me/emails/email-id/verify'],
            ['POST', '/api/v1/me/emails/email-id/primary'], ['DELETE', '/api/v1/me/emails/email-id'],
        ]);
        assert.ok(srv.requests.every((r) => r.headers.authorization === 'Bearer person-token'));
        assert.deepEqual(JSON.parse(srv.requests[1].body.toString()), { email: 'person@example.test' });
        await srv.close();
    }],
    ['viewer: who is looking, from Network (a guest without a call; a refused token throws 401)', async () => {
        let calls = 0;
        const guest = createViewerClient({ fetchImpl: async () => { calls += 1; throw new Error('no call expected'); } });
        assert.deepEqual(await guest.viewer(), { signedIn: false, rank: 'guest', staff: false, owner: false, id: null, username: null });
        assert.equal(calls, 0, 'no token, no call');
        const srv = await stubServer((req, res) => {
            if (req.headers.authorization === 'Bearer bad') return send(res, 401, { error: 'unauthorized' });
            send(res, 200, { viewer: { signedIn: true, rank: 'mod', staff: true, owner: false, id: 'usr_01JZZZVIEWERTEST000000000', username: 'moddy', extra: 'dropped' } });
        });
        const v = createViewerClient({ networkUrl: srv.url, getToken: async () => 'tok' });
        assert.deepEqual(await v.viewer(), { signedIn: true, rank: 'mod', staff: true, owner: false, id: 'usr_01JZZZVIEWERTEST000000000', username: 'moddy' });
        assert.equal(srv.requests[0].url, '/api/v1/viewer');
        assert.equal(srv.requests[0].headers.authorization, 'Bearer tok');
        const bad = createViewerClient({ networkUrl: srv.url, getToken: () => 'bad' });
        await assert.rejects(bad.viewer(), (err) => err.status === 401);
        await srv.close();
    }],
]);
