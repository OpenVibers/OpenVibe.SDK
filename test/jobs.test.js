'use strict';
/**
 * openvibe-sdk/jobs against the mock platform's Tools jobs: submit once (Idempotency-Key), follow
 * events across dropped streams and a restart (Last-Event-ID), 204 when finished, cancel, result
 * files as raw Responses, owner scoping, failures, and sandbox refusal.
 */
const assert = require('node:assert/strict');
const { run, stubServer, send } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createJobsClient, isTerminal } = require('../src/jobs');
const { createMockPlatform } = require('../src/testing');

const APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR';
const OTHER = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TS';

function setup(jobs = {}, extra = {}) {
    const platform = createMockPlatform({
        jobs: { stepMs: 5, ...jobs },
        apps: {
            [APP]: { env: 'production', secret: 'a', grants: ['tools.job.create', 'tools.job.read', 'tools.job.cancel'] },
            [OTHER]: { env: 'production', secret: 'b', grants: ['tools.job.create', 'tools.job.read'] },
        },
        ...extra,
    });
    const clientFor = (id, secret) => createClient({ fetch: platform.fetch, retryDelayMs: 5, tokenProvider: createServiceTokenClient({ clientId: id, clientSecret: secret, fetch: platform.fetch }) });
    return { platform, jobs: createJobsClient(clientFor(APP, 'a')), other: createJobsClient(clientFor(OTHER, 'b')) };
}

run([
    ['submit (multipart) -> follow events -> succeeded -> download the result file', async () => {
        const { jobs, platform } = setup({
            handlers: {
                'img.process': async ({ input, files, progress }) => {
                    await progress(25, 'decoding');
                    await progress(75, 'encoding');
                    return { data: { tool: input.tool }, files: [{ name: files[0].name.replace(/\.\w+$/, '.webp'), mime: 'image/webp', bytes: Buffer.concat([Buffer.from('webp:'), files[0].bytes]) }] };
                },
            },
        });
        const { job, replayed, idempotencyKey } = await jobs.submit({ type: 'img.process', input: { tool: 'convert' }, files: [{ name: 'a.png', data: Buffer.from('PNG') }] });
        assert.match(job.id, /^job_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(job.state, 'queued');
        assert.equal(replayed, false);
        assert.match(idempotencyKey, /^idem_/);
        const call = platform.stats.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/v1/jobs'));
        assert.equal(call.url, 'https://openvibe.tools/api/v1/jobs', 'origin from discovery');
        assert.equal(call.headers['idempotency-key'], idempotencyKey);
        assert.match(call.headers['content-type'], /^multipart\/form-data/);

        const seen = [];
        const done = await jobs.wait(job.id, { onEvent: (e) => seen.push([e.id, e.event, e.job.progress.percent]) });
        assert.deepEqual(seen.map((s) => s[1]), ['job.queued', 'job.running', 'job.progress', 'job.progress', 'job.succeeded']);
        assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5]);
        assert.equal(done.state, 'succeeded');
        assert.ok(isTerminal(done));
        assert.deepEqual(done.result.data, { tool: 'convert' });
        const res = await jobs.file(job.id, 0);
        assert.ok(res instanceof Response);
        assert.equal(res.headers.get('content-type'), 'image/webp');
        assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'webp:PNG');
        assert.equal([...(await (async () => { const out = []; for await (const e of jobs.events(job.id, { lastEventId: 5 })) out.push(e); return out; })())].length, 0, '204: finished, nothing newer');
    }],

    ['the same Idempotency-Key gets the same job; a different request under it is a conflict', async () => {
        const { jobs, platform } = setup();
        const a = await jobs.submit({ type: 'doc.render', input: { n: 1 }, idempotencyKey: 'idem_example_0001' });
        const b = await jobs.submit({ type: 'doc.render', input: { n: 1 }, idempotencyKey: 'idem_example_0001' });
        assert.equal(b.job.id, a.job.id);
        assert.equal(b.replayed, true);
        assert.equal(platform.state.jobs.size, 1);
        await assert.rejects(jobs.submit({ type: 'doc.render', input: { n: 2 }, idempotencyKey: 'idem_example_0001' }), { status: 409, code: 'tools.job.idempotency_conflict' });
        const json = platform.stats.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/v1/jobs'))[0];
        assert.match(json.headers['content-type'], /^application\/json/, 'no files: a JSON body');
        await assert.rejects(jobs.submit({ input: {} }), TypeError);
    }],

    ['events reattach after dropped streams and after a restart, each event once and in order', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { jobs, platform } = setup({
            handlers: {
                slow: async ({ progress }) => {
                    await progress(10, 'a');
                    await gate;
                    await progress(90, 'b');
                    return { data: { ok: true } };
                },
            },
        });
        const { job } = await jobs.submit({ type: 'slow' });
        const first = [];
        for await (const e of jobs.events(job.id, { reconnectDelayMs: 5 })) {
            first.push(e.id);
            if (e.event === 'job.progress') break;                 // "crash" after saving id 3
        }
        assert.deepEqual(first, [1, 2, 3]);
        const second = [];
        const following = (async () => {
            for await (const e of jobs.events(job.id, { lastEventId: first.at(-1), reconnectDelayMs: 5 })) {
                second.push([e.id, e.event]);
                if (second.length === 1) platform.dropJobStreams();      // the connection drops mid-job
            }
        })();
        setTimeout(release, 20);
        await following;
        assert.deepEqual(second.map((s) => s[0]), [4, 5]);
        assert.deepEqual(second.map((s) => s[1]), ['job.progress', 'job.succeeded']);
        const reconnects = platform.stats.requests.filter((r) => r.url.endsWith('/events')).map((r) => r.headers['last-event-id']);
        assert.ok(reconnects.includes('3') && reconnects.includes('4'), `resumed with Last-Event-ID (${reconnects})`);
    }],

    ['cancel: queued -> cancelled; finished -> 409; failures carry the error', async () => {
        const { jobs } = setup({ stepMs: 30, handlers: { boom: async () => { throw Object.assign(new Error('bad input'), { code: 'tools.job.invalid_input' }); }, ok: async () => ({}) } });
        const { job } = await jobs.submit({ type: 'ok' });
        const cancelled = await jobs.cancel(job.id);
        assert.equal(cancelled.state, 'cancelled');
        const failed = await jobs.submit({ type: 'boom' });
        const out = await jobs.wait(failed.job.id);
        assert.equal(out.state, 'failed');
        assert.deepEqual(out.error, { code: 'tools.job.invalid_input', detail: 'bad input' });
        await assert.rejects(jobs.cancel(failed.job.id), { status: 409, code: 'tools.job.already_finished' });
        await assert.rejects(jobs.file(failed.job.id, 0), { status: 409, code: 'tools.job.not_ready' });
        await assert.rejects(jobs.submit({ type: 'nope' }), { status: 400, code: 'tools.job.unknown_type' });
    }],

    ['cancel while running: 202 cancel requested, then cancelled', async () => {
        const { jobs } = setup({ handlers: { long: async ({ progress }) => { for (let i = 1; i <= 5; i++) await progress(i * 20); return {}; } } });
        const { job } = await jobs.submit({ type: 'long' });
        const events = [];
        for await (const e of jobs.events(job.id)) {
            events.push(e.event);
            if (e.event === 'job.running') {
                const c = await jobs.cancel(job.id);
                assert.equal(c.cancel_requested, true);
                assert.equal(c.state, 'running');
            }
        }
        assert.ok(events.includes('job.cancel_requested'));
        assert.equal(events.at(-1), 'job.cancelled');
        assert.equal((await jobs.get(job.id)).state, 'cancelled');
    }],

    ['jobs are owner-scoped; capabilities and sandbox tokens are checked', async () => {
        const { jobs, other } = setup();
        const { job } = await jobs.submit({ type: 'x' });
        assert.equal(await other.get(job.id), null, 'another app gets 404, as for a job that does not exist');
        await assert.rejects(other.cancel(job.id), { status: 403, code: 'capability.denied' });
        assert.equal((await jobs.get(job.id)).id, job.id);

        const SANDBOX = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TT';
        const make = (extra) => {
            const p = createMockPlatform({ jobs: true, apps: { [SANDBOX]: { env: 'sandbox', secret: 's', grants: ['tools.job.create'] } }, ...extra });
            return createJobsClient(createClient({ fetch: p.fetch, tokenProvider: createServiceTokenClient({ clientId: SANDBOX, clientSecret: 's', fetch: p.fetch }) }));
        };
        await assert.rejects(make().submit({ type: 'x' }), { status: 401, code: 'token.sandbox_refused' });
        assert.equal((await make({ acceptSandbox: ['openvibe.tools'] }).submit({ type: 'x' })).job.state, 'queued');
        await assert.rejects(createJobsClient(createClient({ fetch: createMockPlatform().fetch, token: 't' })).submit({ type: 'x' }), { status: 404 }, 'jobs are opt-in on the mock');
    }],

    ['events: a 5xx or a dropped connection reconnects, a 4xx is thrown, the give-up limit holds', async () => {
        let calls = 0;
        const srv = await stubServer((req, res) => {
            calls++;
            if (calls === 1) return send(res, 503, { code: 'x.down' });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (calls === 2) { res.write(`id: 1\nevent: job.running\ndata: ${JSON.stringify({ id: 'job_1', state: 'running' })}\n\n`); return res.end(); }
            res.write(`id: 1\nevent: job.running\ndata: {}\n\nid: 2\nevent: job.succeeded\ndata: ${JSON.stringify({ id: 'job_1', state: 'succeeded' })}\n\n`);
            return res.end();
        });
        const jobs = createJobsClient(createClient({ baseUrls: { tools: srv.url }, token: 't' }));
        const got = [];
        for await (const e of jobs.events('job_1', { reconnectDelayMs: 1 })) got.push(e.id);
        assert.deepEqual(got, [1, 2], 'the replayed id 1 is not yielded twice');
        assert.equal(srv.requests[2].headers['last-event-id'], '1');
        await srv.close();

        const gone = await stubServer((req, res) => send(res, 404, { code: 'tools.job.not_found', status: 404 }));
        await assert.rejects((async () => { for await (const e of createJobsClient(createClient({ baseUrls: { tools: gone.url }, token: 't' })).events('job_x')) void e; })(), { code: 'tools.job.not_found' });
        await gone.close();
        const down = await stubServer((req, res) => send(res, 502, 'bad gateway'));
        await assert.rejects((async () => { for await (const e of createJobsClient(createClient({ baseUrls: { tools: down.url }, token: 't' })).events('job_x', { maxReconnects: 2, reconnectDelayMs: 1 })) void e; })(), { code: 'sdk.network_error' });
        assert.equal(down.requests.length, 3);
        await down.close();
    }],
]);
