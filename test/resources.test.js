'use strict';
/**
 * openvibe-sdk/resources: OVRN names (contracts.resources helpers), the resource index fanning out over
 * authorities and merging common.resource-list-result@1 pages (cursor, stale authority), and the control
 * client posting common.resource-control-request@1 to /api/v1/resources/control (posts, retries, refused).
 */
const assert = require('node:assert/strict');
const { run, stubServer, send, problem } = require('./helpers');
const {
    parseResourceName, resourceName, resourceNameOf, RESOURCE_KINDS,
    createResourceIndex, createResourceClient,
} = require('../src/resources');

const PRJ = 'prj_01J0000000000000000000000A';
const PRJ2 = 'prj_01J0000000000000000000000B';
const MED = 'med_01K0000000000000000000000A';
const MED2 = 'med_01K0000000000000000000000B';
const WCH = 'wch_01K0000000000000000000000C';

const summary = (id, { kind = 'media.object', project_id = PRJ, service = 'media' } = {}) =>
    ({ id, kind, service, project_id, state: 'active', created_at: '2026-10-05T00:00:00Z' });
const page = (resources, next_cursor = null) => ({ resources, next_cursor });

run([
    ['OVRN: compose from a summary, parse back, and reject what is not a resource name', async () => {
        const name = resourceName({ service: 'media', project_id: PRJ, type: 'object', id: MED });
        assert.equal(name, `ovrn:media:${PRJ}:object/${MED}`);
        assert.deepEqual(parseResourceName(name), { service: 'media', project_id: PRJ, type: 'object', id: MED });
        assert.equal(resourceNameOf(summary(MED)), name, 'composed from kind + service + project_id + id');
        assert.equal(resourceNameOf(summary(WCH, { kind: 'watch.watch', service: 'watch' })), `ovrn:watch:${PRJ}:watch/${WCH}`);
        assert.equal(resourceNameOf(summary(MED, { kind: 'watch.watch' })), null, 'kind must belong to the summary service');

        assert.equal(parseResourceName('not-a-name'), null);
        assert.equal(parseResourceName(`ovrn:media:${PRJ}:object/usr_01K0000000000000000000000A`), null, 'a person is never a resource');
        assert.equal(parseResourceName(`ovrn:media:prj_not-a-ulid:object/${MED}`), null);
        assert.equal(resourceNameOf({ id: MED, service: 'media' }), null, 'no kind: nothing to compose');
        assert.throws(() => resourceName({ service: 'media', project_id: PRJ, type: 'object', id: 'usr_01K0000000000000000000000A' }), TypeError);

        assert.deepEqual(RESOURCE_KINDS, [
            { kind: 'media.object', service: 'media', type: 'object', prefix: 'med' },
            { kind: 'watch.watch', service: 'watch', type: 'watch', prefix: 'wch' },
        ], 'only the chosen prefixes; act/run/zon are proposed and events.queue/subscription and codes.repo unchosen');
    }],

    ['the index fans out over two authorities and merges their pages, with the filters on the query', async () => {
        const a = await stubServer((req, res) => send(res, 200, page([summary(MED)])));
        const b = await stubServer((req, res) => send(res, 200, page([summary(MED2)])));
        try {
            const index = createResourceIndex({ authorities: [a.url, b.url], token: 'svc-token', pageLimit: 25 });
            const { resources, stale } = await index.list({ project: PRJ, kind: 'media.object' });
            assert.deepEqual(resources.map((r) => r.id), [MED, MED2], 'authority order, each page merged');
            assert.deepEqual(stale, []);
            for (const srv of [a, b]) {
                assert.equal(srv.requests.length, 1);
                assert.equal(srv.requests[0].method, 'GET');
                assert.equal(srv.requests[0].headers.authorization, 'Bearer svc-token');
                const url = new URL(srv.requests[0].url, srv.url);
                assert.equal(url.pathname, '/api/v1/resources');
                assert.equal(url.searchParams.get('project'), PRJ);
                assert.equal(url.searchParams.get('kind'), 'media.object');
                assert.equal(url.searchParams.get('limit'), '25');
                assert.equal(url.searchParams.has('cursor'), false, 'the first page names no cursor');
            }
        } finally { await a.close(); await b.close(); }
    }],

    ['the index follows each authority next_cursor to the end', async () => {
        const srv = await stubServer((req, res) => {
            const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
            if (!cursor) return send(res, 200, page([summary(MED)], 'c2'));
            assert.equal(cursor, 'c2');
            return send(res, 200, page([summary(MED2)], null));
        });
        try {
            const index = createResourceIndex({ authorities: [srv.url] });
            const { resources } = await index.list({ project: PRJ });
            assert.deepEqual(resources.map((r) => r.id), [MED, MED2]);
            assert.equal(srv.requests.length, 2);
            assert.equal(new URL(srv.requests[1].url, srv.url).searchParams.get('cursor'), 'c2');
        } finally { await srv.close(); }
    }],

    ['one authority answering 500 is reported stale; the others still merge', async () => {
        const bad = await stubServer((req, res) => {
            const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
            if (!cursor) return send(res, 200, page([summary(MED)], 'c2'));           // page 1 read, then it fails
            return problem(res, 500, 'internal.error', 'boom');
        });
        const ok = await stubServer((req, res) => send(res, 200, page([summary(MED2)])));
        try {
            const index = createResourceIndex({ authorities: [bad.url, ok.url] });
            const { resources, stale } = await index.list({ project: PRJ });
            assert.deepEqual(resources.map((r) => r.id).sort(), [MED, MED2].sort(), 'the pages read are kept; the other authority merges');
            assert.equal(stale.length, 1);
            assert.equal(stale[0].authority, bad.url);
            assert.equal(stale[0].status, 500);
            assert.equal(stale[0].code, 'internal.error');
            assert.match(stale[0].error, /500/);
        } finally { await bad.close(); await ok.close(); }
    }],

    ['control posts a common.resource-control-request@1 as a bearer of the caller', async () => {
        const srv = await stubServer((req, res) => send(res, 200, { action: 'delete', resource: `ovrn:media:${PRJ}:object/${MED}`, state: 'done', at: '2026-10-05T00:00:00Z' }));
        try {
            const client = createResourceClient({ origin: srv.url, token: 'user-jwt' });
            const result = await client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}` });
            assert.equal(result.state, 'done');
            assert.equal(srv.requests.length, 1);
            assert.equal(srv.requests[0].method, 'POST');
            assert.equal(srv.requests[0].headers.authorization, 'Bearer user-jwt');
            const body = JSON.parse(srv.requests[0].body.toString());
            assert.equal(body.action, 'delete');
            assert.equal(body.project_id, PRJ);
            assert.match(body.idempotency_key, /^idem_[0-9A-HJKMNP-TV-Z]{26}$/, 'generated when the caller omits it');
            assert.equal(new URL(srv.requests[0].url, srv.url).pathname, '/api/v1/resources/control');
            assert.equal(client.path, '/api/v1/resources/control');

            await assert.rejects(
                client.control({ action: 'create', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}` }),
                /not a valid common.resource-control-request@1/,
                'create names resource_kind, never resource',
            );
            assert.equal(srv.requests.length, 1, 'an invalid request never reaches the authority');
        } finally { await srv.close(); }
    }],

    ['control retries a transient answer with the same idempotency key and body', async () => {
        const seen = [];
        const srv = await stubServer((req, res, body) => {
            seen.push(JSON.parse(body.toString()));
            if (seen.length === 1) return problem(res, 503, 'service.unavailable', 'try again');
            return send(res, 200, { action: 'rotate', state: 'done', at: '2026-10-05T00:00:00Z' });
        });
        try {
            const client = createResourceClient({ origin: srv.url, token: 'svc', retryDelayMs: 1 });
            const result = await client.control({ action: 'rotate', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'retry-test-given-key' });
            assert.equal(result.state, 'done');
            assert.equal(seen.length, 2);
            assert.deepEqual(seen[0], seen[1], 'a retry repeats the exact request, so the authority applies it once');
            assert.equal(seen[0].idempotency_key, 'retry-test-given-key');
        } finally { await srv.close(); }
    }],

    ['control returns a refused result (confirmation gate) instead of throwing', async () => {
        const srv = await stubServer((req, res) => send(res, 200, {
            action: 'delete', state: 'refused', at: '2026-10-05T00:00:00Z',
            confirmation_required: { confirmation_id: 'cnf_01K0000000000000000000000A', reason: 'the owner must approve a delete' },
        }));
        try {
            const client = createResourceClient({ origin: srv.url });
            const result = await client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'approve-test-key' });
            assert.equal(result.state, 'refused');
            assert.equal(result.confirmation_required.confirmation_id, 'cnf_01K0000000000000000000000A');
            assert.equal(srv.requests[0].headers.authorization, undefined, 'no token: no header');
        } finally { await srv.close(); }
    }],

    ['the index stops and reports stale when an authority repeats a cursor (a cycle)', async () => {
        const srv = await stubServer((req, res) => {
            const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
            const next = cursor === 'A' ? 'B' : 'A';   // A -> B -> A never ends
            return send(res, 200, page([summary(MED)], next));
        });
        try {
            const index = createResourceIndex({ authorities: [srv.url] });
            const { resources, stale } = await index.list({ project: PRJ });
            assert.equal(stale.length, 1);
            assert.equal(stale[0].authority, srv.url);
            assert.equal(stale[0].code, 'sdk.bad_response');
            assert.match(stale[0].error, /cursor repeated/);
            assert.deepEqual(resources.map((r) => r.id), [MED, MED, MED], 'the pages read are kept');
            assert.equal(srv.requests.length, 3, 'page 1 (no cursor), A, then B repeats A');
        } finally { await srv.close(); }
    }],

    ['the index stops an endless cursor stream at maxPages and reports stale', async () => {
        let n = 0;
        const srv = await stubServer((req, res) => send(res, 200, page([summary(MED)], `cursor-${++n}`)));
        try {
            const index = createResourceIndex({ authorities: [srv.url], maxPages: 3 });
            const { resources, stale } = await index.list({ project: PRJ });
            assert.equal(srv.requests.length, 3, 'maxPages bounds the walk');
            assert.equal(resources.length, 3, 'the pages read are kept');
            assert.equal(stale.length, 1);
            assert.equal(stale[0].code, 'sdk.bad_response');
            assert.match(stale[0].error, /did not end after 3 pages/);
        } finally { await srv.close(); }
    }],

    ['the index reports a walk past its maxMs deadline as stale', async () => {
        const srv = await stubServer((req, res) => setTimeout(() => send(res, 200, page([summary(MED)], 'more')), 30));
        try {
            const index = createResourceIndex({ authorities: [srv.url], maxMs: 15 });
            const { resources, stale } = await index.list({ project: PRJ });
            assert.equal(resources.length, 1, 'the first page is kept');
            assert.equal(stale.length, 1);
            assert.equal(stale[0].code, 'sdk.timeout');
            assert.match(stale[0].error, /maxMs/);
        } finally { await srv.close(); }
    }],

    ['an empty next_cursor ends the walk (no cursor= request)', async () => {
        const srv = await stubServer((req, res) => send(res, 200, page([summary(MED)], '')));
        try {
            const index = createResourceIndex({ authorities: [srv.url] });
            const { resources, stale } = await index.list({ project: PRJ });
            assert.deepEqual(resources.map((r) => r.id), [MED]);
            assert.deepEqual(stale, []);
            assert.equal(srv.requests.length, 1, 'an empty cursor is the end, not a cursor to follow');
        } finally { await srv.close(); }
    }],

    ['control returns a refused result sent with a non-retryable non-2xx status', async () => {
        const srv = await stubServer((req, res) => problem(res, 409, 'resource.confirmation_required', 'needs approval', {
            action: 'delete', state: 'refused', at: '2026-10-05T00:00:00Z',
            confirmation_required: { confirmation_id: 'cnf_01K0000000000000000000000A', reason: 'the owner must approve a delete' },
        }));
        try {
            const client = createResourceClient({ origin: srv.url, retryDelayMs: 1 });
            const result = await client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'conflict-refused-key' });
            assert.equal(result.state, 'refused');
            assert.equal(result.confirmation_required.confirmation_id, 'cnf_01K0000000000000000000000A');
            assert.equal(srv.requests.length, 1, 'a non-retryable status is not retried');
        } finally { await srv.close(); }
    }],

    ['a 5xx refused body still retries first, then throws with the idempotency key', async () => {
        const srv = await stubServer((req, res) => problem(res, 503, 'service.unavailable', 'try again', {
            action: 'delete', state: 'refused', at: '2026-10-05T00:00:00Z', problem: { detail: 'busy' },
        }));
        try {
            const client = createResourceClient({ origin: srv.url, retries: 1, retryDelayMs: 1 });
            const err = await client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'busy-refused-key' })
                .then(() => null, (e) => e);
            assert.ok(err, 'a retryable status still throws after the retries');
            assert.equal(srv.requests.length, 2);
            assert.equal(err.idempotencyKey, 'busy-refused-key');
            assert.equal(JSON.parse(srv.requests[1].body.toString()).idempotency_key, 'busy-refused-key');
        } finally { await srv.close(); }
    }],

    ['a non-retryable non-2xx without a refused/failed body is still thrown', async () => {
        const srv = await stubServer((req, res) => problem(res, 403, 'authorization.denied', 'no capability'));
        try {
            const client = createResourceClient({ origin: srv.url });
            await assert.rejects(
                client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'forbidden-test-key' }),
                (err) => err.code === 'authorization.denied' && err.status === 403,
            );
            assert.equal(srv.requests.length, 1);
        } finally { await srv.close(); }
    }],

    ['a thrown control error carries the generated idempotency key', async () => {
        let sawKey;
        const srv = await stubServer((req, res, body) => {
            sawKey = JSON.parse(body.toString()).idempotency_key;
            return problem(res, 500, 'internal.error', 'boom');
        });
        try {
            const client = createResourceClient({ origin: srv.url, retries: 0 });
            const err = await client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}` })
                .then(() => null, (e) => e);
            assert.ok(err);
            assert.match(err.idempotencyKey, /^idem_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.equal(err.idempotencyKey, sawKey, 'the key the authority saw is returned to the caller');
        } finally { await srv.close(); }
    }],

    ['a real error from the contracts validator propagates instead of the weak shape check', async () => {
        const contracts = require(require.resolve('openvibe-contracts'));
        const original = contracts.resources.checkControlRequest;
        const srv = await stubServer((req, res) => send(res, 200, { action: 'delete', state: 'done', at: '2026-10-05T00:00:00Z' }));
        try {
            contracts.resources.checkControlRequest = () => { throw new Error('contracts validator exploded'); };
            const client = createResourceClient({ origin: srv.url });
            await assert.rejects(
                client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ}:object/${MED}`, idempotency_key: 'validator-test-key' }),
                /contracts validator exploded/,
            );
            assert.equal(srv.requests.length, 0, 'a validator error never degrades into sending the request');
        } finally {
            contracts.resources.checkControlRequest = original;
            await srv.close();
        }
    }],

    ['control enforces the project-tenancy rule through the contracts validator', async () => {
        const srv = await stubServer((req, res) => send(res, 200, { action: 'delete', state: 'done', at: '2026-10-05T00:00:00Z' }));
        try {
            const client = createResourceClient({ origin: srv.url });
            await assert.rejects(
                client.control({ action: 'delete', project_id: PRJ, resource: `ovrn:media:${PRJ2}:object/${MED}`, idempotency_key: 'tenancy-test-key' }),
                /not a valid common.resource-control-request@1/,
            );
            assert.equal(srv.requests.length, 0, 'a cross-project resource is never sent');
        } finally { await srv.close(); }
    }],

    ['STATUS.json lists the resources module among the capabilities', async () => {
        const status = require('../STATUS.json');
        assert.ok(
            status.features.some((f) => /openvibe-sdk\/resources/.test(f)),
            'the capability list names openvibe-sdk/resources',
        );
        assert.equal(status.version, require('../package.json').version);
    }],
]);
