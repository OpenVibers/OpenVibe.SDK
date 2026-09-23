'use strict';
/**
 * openvibe-sdk/tools against a stand-in of the Tools gateway: the mock platform's tools API
 * (createMockPlatform({ tools })), wrapped so every run request is checked against
 * tools.run-request@1 and every answer against its contract (tools.tool-list@1 + checkList,
 * tools.tool@1 + checkDescriptor, tools.run@1, tools.job@1, errors.problem@1) from the pinned
 * openvibe-contracts devDependency. Hooks inject what the mock does not model (429, lost answers).
 */
const assert = require('node:assert/strict');
const contracts = require('openvibe-contracts');
const { run } = require('./helpers');
const { createClient, OpenVibeError, isOpenVibeError } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createToolsClient, ToolRunError, isToolRunError } = require('../src/tools');
const { createJobsClient } = require('../src/jobs');
const { createMockPlatform } = require('../src/testing');

const APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR';
const PROBER = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TS';
const OTHER = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TT';
const RUNNER = ['tools.tool.run', 'tools.job.create', 'tools.job.read', 'tools.job.cancel'];

/** A job tool descriptor for tests (tools.tool@1). */
const jobTool = (id, extra = {}) => ({
    id, family: 'docs', name: id, summary: `The ${id} test tool.`, status: 'stable', execution: 'job', api: true,
    run: { method: 'POST', path: `/api/v1/tools/${id}/run`, job: { type: 'docs.process', operation: id } },
    input: { type: 'object', properties: {} }, files: null, output: { kind: 'json', schema: { type: 'object' } },
    limits: { timeoutMs: 60000 }, auth: { anonymous: false, capability: 'tools.tool.run' }, quotaClass: 'tools-job', cost: 2, egress: false,
    hosts: [], docs: `https://openvibe.tools/tool/${id}`, ...extra,
});
const syncTool = (id, extra = {}) => ({ ...jobTool(id), family: 'dev', execution: 'sync', run: { method: 'POST', path: `/api/v1/tools/${id}/run`, job: null }, auth: { anonymous: true, capability: 'tools.tool.run' }, quotaClass: 'tools-run', ...extra });

/**
 * standIn({ tools, …platform options }, { before, after }) -> { platform, fetch, violations, runs, responses, client(), anon(), user() }
 * before(req, url) may answer instead of the mock; after(req, url, res) may replace its answer.
 */
function standIn(opts = {}, { before, after } = {}) {
    const { tools = {}, apps = {}, ...rest } = opts;
    const platform = createMockPlatform({
        tools: { stepMs: 2, ...tools },
        users: [{ username: 'ana' }],
        apps: {
            [APP]: { env: 'production', secret: 'a', grants: RUNNER },
            [PROBER]: { env: 'production', secret: 'p', grants: ['tools.net.probe', 'tools.tool.run'] },
            [OTHER]: { env: 'production', secret: 'o', grants: RUNNER },
            ...apps,
        },
        ...rest,
    });
    const violations = [];
    const runs = [];
    const responses = [];
    const check = (ref, value, where) => {
        const r = ref === 'list' ? contracts.tools.checkList(value) : ref === 'descriptor' ? contracts.tools.checkDescriptor(value) : contracts.validate(ref, value);
        if (!r.valid) violations.push(`${where}: ${JSON.stringify(r.errors)}`);
    };

    async function fetch(input, init) {
        const req = new Request(input, init);
        const url = new URL(req.url);
        const isRun = req.method === 'POST' && /^\/api\/v1\/tools\/[^/]+\/run$/.test(url.pathname);
        if (isRun) {
            const copy = req.clone();
            const multipart = (copy.headers.get('content-type') || '').startsWith('multipart/form-data');
            const body = {};
            const uploads = [];
            if (multipart) {
                for (const [k, v] of (await copy.formData()).entries()) {
                    if (typeof v !== 'string') uploads.push({ part: k, name: v.name, type: v.type, text: await v.text() });
                    else body[k] = k === 'wait_ms' ? Number(v) : k === 'input' || k === 'files' ? JSON.parse(v) : v;
                }
            } else Object.assign(body, await copy.json());
            runs.push({ tool: url.pathname.split('/')[4], key: req.headers.get('idempotency-key'), auth: req.headers.get('authorization'), multipart, body, uploads });
            check('tools.run-request@1', body, `request ${url.pathname}`);
        }
        let res = before ? await before(req, url) : null;
        if (!res) res = await platform.fetch(req);
        if (after) res = (await after(req, url, res)) || res;
        responses.push({ method: req.method, path: url.pathname, status: res.status });
        if (/json/.test(res.headers.get('content-type') || '')) {
            const data = await res.clone().json();
            const where = `${req.method} ${url.pathname} ${res.status}`;
            if (!res.ok) check('errors.problem@1', data, where);
            else if (url.pathname === '/api/v1/tools') check('list', data, where);
            else if (/^\/api\/v1\/tools\/[^/]+$/.test(url.pathname)) check('descriptor', data, where);
            else if (isRun) check('tools.run@1', data, where);
            else if (/^\/api\/v1\/jobs(\/|$)/.test(url.pathname)) check('tools.job@1', data, where);
        }
        return res;
    }

    const make = (extra) => createClient({ fetch, retryDelayMs: 5, ...extra });
    const appClient = (id = APP, secret = 'a', extra = {}) => make({ tokenProvider: createServiceTokenClient({ clientId: id, clientSecret: secret, fetch: platform.fetch }), ...extra });
    return {
        platform, fetch, violations, runs, responses,
        client: appClient,
        anon: (extra) => make(extra),
        user: (extra) => make({ token: platform.signUserToken([...platform.state.users.values()][0]), ...extra }),
    };
}

const statusOf = (s, path) => s.responses.filter((r) => r.path === path).map((r) => r.status);

run([
    ['registry: list (tools.tool-list@1, filters), get (tools.tool@1), schema; 404 -> null', async () => {
        const s = standIn();
        for (const d of s.platform.state.tools.values()) assert.deepEqual(contracts.tools.checkDescriptor(d).errors, [], `mock default ${d.id}`);
        const tools = createToolsClient(s.client());

        const all = await tools.list();
        assert.equal(all.count, 6);
        assert.deepEqual(all.tools.map((t) => t.id).sort(), ['dns', 'jsonminify', 'png', 'port', 'protectpdf', 'yt']);
        assert.deepEqual(all.tools.find((t) => t.id === 'png').input, { $ref: 'https://openvibe.tools/api/v1/tools/png/schema#/$defs/input' }, 'the list $refs the schemas');
        assert.ok(all.families.some((f) => f.id === 'net' && f.count === 2));
        assert.deepEqual((await tools.list({ family: 'net' })).tools.map((t) => t.id), ['dns', 'port']);
        assert.deepEqual((await tools.list({ api: false })).tools.map((t) => t.id), ['yt']);
        assert.deepEqual((await tools.list({ execution: 'job', q: 'PNG' })).tools.map((t) => t.id), ['png']);
        const reads = s.platform.stats.requests.filter((r) => r.url.includes('/api/v1/tools'));
        assert.ok(reads.some((r) => r.url === 'https://openvibe.tools/api/v1/tools?api=false'), 'api=false is sent, not dropped');
        assert.ok(reads.every((r) => !r.headers.authorization), 'registry reads are anonymous by default');

        const png = await tools.get('png');
        assert.equal(png.execution, 'job');
        assert.equal(png.input.type, 'object', 'get embeds the schemas');
        assert.deepEqual(png.run.job, { type: 'img.process', operation: 'convert', preset: { format: 'png' } });
        assert.equal(await tools.get('nope'), null);
        const schema = await tools.schema('dns');
        assert.equal(schema.$id, 'https://openvibe.tools/api/v1/tools/dns/schema');
        assert.deepEqual(schema.$defs.input.required, ['target']);
        assert.deepEqual(Object.keys(schema.$defs.output.properties), ['target', 'type', 'records']);
        assert.equal(await tools.schema('nope'), null);
        await assert.rejects(tools.get('Not An Id'), TypeError);
        await assert.rejects(tools.schema('../x'), TypeError);

        await createToolsClient(s.client(), { anonymousReads: false }).get('dns');
        assert.match(s.platform.stats.requests.at(-1).headers.authorization, /^Bearer /, 'anonymousReads: false sends the token');
        assert.deepEqual(s.violations, []);
    }],

    ['sync run: finished inline; the body is tools.run-request@1 with a generated Idempotency-Key', async () => {
        const s = standIn();
        const anon = createToolsClient(s.anon());
        const out = await anon.run('jsonminify', { text: '{ "a": [1, 2] }' });
        assert.deepEqual({ ...out, took_ms: 0 }, { state: 'succeeded', tool: 'jsonminify', result: { text: '{"a":[1,2]}' }, took_ms: 0, idempotencyKey: out.idempotencyKey, replayed: false });
        assert.equal(typeof out.took_ms, 'number');
        assert.equal(await out.wait(), out, 'a finished run waits for nothing');
        assert.ok(!('wait' in JSON.parse(JSON.stringify(out))), 'wait is not data');
        assert.deepEqual(s.runs[0].body, { input: { text: '{ "a": [1, 2] }' } });
        assert.equal(s.runs[0].multipart, false);
        assert.equal(s.runs[0].auth, null, 'no token: anonymous tier');
        assert.match(s.runs[0].key, /^idem_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(s.runs[0].key, out.idempotencyKey);
        assert.deepEqual(statusOf(s, '/api/v1/tools/jsonminify/run'), [200]);

        const tools = createToolsClient(s.client());
        const dns = await tools.run('dns', { target: 'example.com', type: 'MX' });
        assert.deepEqual(dns.result.data, { target: 'example.com', type: 'MX', records: ['10 mail.example.com'] });
        assert.equal(dns.job, undefined, 'an inline run has no job');
        await assert.rejects(tools.run('dns', { type: 'A' }), (err) => {
            assert.ok(isOpenVibeError(err) && !isToolRunError(err), 'a refusal before the tool ran is a plain OpenVibeError');
            assert.equal(err.status, 422);
            assert.equal(err.code, 'tools.input.invalid');
            assert.deepEqual(err.errors, [{ path: '/target', message: 'is required' }]);
            return true;
        });
        await assert.rejects(tools.run('yt', {}), { status: 404, code: 'tools.tool.not_runnable' });
        await assert.rejects(tools.run('nope', {}), { status: 404, code: 'tools.tool.not_found' });
        await assert.rejects(createToolsClient(s.client(APP, 'a', { retries: 0 })).run('protectpdf', { password: 'x' }), { status: 503, code: 'tools.tool.unavailable' });
        await assert.rejects(tools.run('dns', 'example.com'), TypeError);
        await assert.rejects(tools.run('dns', {}, { waitMs: 60001 }), TypeError);

        // Tiers: probes need tools.net.probe; a person uses the page, not the API.
        const probe = { host: 'example.com', ports: [22, 443] };
        await assert.rejects(anon.run('port', probe), { status: 401, code: 'token.missing' });
        await assert.rejects(createToolsClient(s.user()).run('port', probe), { status: 403, code: 'capability.denied' });
        await assert.rejects(tools.run('port', probe), { status: 403, code: 'capability.denied' });
        const ok = await createToolsClient(s.client(PROBER, 'p')).run('port', probe);
        assert.deepEqual(ok.result.data.results.map((r) => r.port), [22, 443]);
        assert.equal((await createToolsClient(s.user()).run('dns', { target: 'example.org' })).state, 'succeeded');
        assert.deepEqual(s.violations, []);
    }],

    ['job run: 202 -> { state, job, location } -> wait() -> the result; waitMs answers finished', async () => {
        const s = standIn();
        const client = s.client();
        const tools = createToolsClient(client);
        const r = await tools.run('png', { quality: 80 }, { files: [{ name: 'photo.jpg', data: Buffer.from('JPEG'), type: 'image/jpeg' }] });
        assert.equal(r.state, 'queued');
        assert.equal(r.tool, 'png');
        assert.match(r.job.id, /^job_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(r.job.tool, 'png');
        assert.equal(r.job.type, 'img.process');
        assert.equal(r.location, `/api/v1/jobs/${r.job.id}`);
        assert.equal(r.replayed, false);
        assert.deepEqual(statusOf(s, '/api/v1/tools/png/run'), [202]);
        assert.equal(s.runs[0].multipart, true);
        assert.deepEqual(s.runs[0].body, { input: { quality: 80 } });
        assert.deepEqual(s.runs[0].uploads, [{ part: 'file', name: 'photo.jpg', type: 'image/jpeg', text: 'JPEG' }]);
        assert.deepEqual(s.platform.state.jobs.get(r.job.id).input, { quality: 80, format: 'png', tool: 'convert' }, 'the preset and the operation win');

        const events = [];
        const done = await r.wait({ onEvent: (e) => events.push(e.event) });
        assert.equal(done.state, 'succeeded');
        assert.deepEqual(done.result.data, { format: 'png' });
        assert.deepEqual(done.result.files.map((f) => [f.name, f.mime, f.size, f.storage]), [['photo.png', 'image/png', 4, 'local']]);
        assert.equal(done.job.state, 'succeeded');
        assert.equal(done.location, r.location);
        assert.equal(typeof done.took_ms, 'number');
        assert.deepEqual(events.slice(0, 2), ['job.queued', 'job.running']);
        assert.equal(events.at(-1), 'job.succeeded');

        // The same job through the jobs client: the gateway facade, the default origin.
        assert.equal((await tools.jobs.wait(r.job.id)).state, 'succeeded');
        assert.equal(Buffer.from(await (await tools.jobs.file(r.job.id, 0)).arrayBuffer()).toString(), 'JPEG');
        assert.equal((await createJobsClient(client).get(r.job.id)).tool, 'png');
        const jobCalls = s.platform.stats.requests.filter((q) => q.url.includes('/api/v1/jobs/'));
        assert.ok(jobCalls.length && jobCalls.every((q) => q.url.startsWith('https://openvibe.tools/api/v1/jobs/')), 'jobs go to the gateway');

        const quick = await tools.run('png', {}, { files: [{ name: 'b.gif', data: 'GIF', type: 'image/gif' }], waitMs: 5000 });
        assert.equal(quick.state, 'succeeded', 'finished within wait_ms: 200 with the result');
        assert.equal(quick.job.state, 'succeeded');
        assert.equal(quick.location, `/api/v1/jobs/${quick.job.id}`);
        assert.equal(await quick.wait(), quick);
        assert.equal(s.runs.at(-1).body.wait_ms, 5000);
        assert.deepEqual(statusOf(s, '/api/v1/tools/png/run'), [202, 200]);

        await assert.rejects(createToolsClient(s.anon()).run('png', {}, { files: [{ name: 'a.png', data: 'x', type: 'image/png' }] }), { status: 401, code: 'token.missing' });
        await assert.rejects(tools.run('png', {}), { status: 400, code: 'tools.run.invalid' });
        await assert.rejects(tools.run('png', {}, { files: [{ name: 'a.pdf', data: 'x', type: 'application/pdf' }] }), { status: 415, code: 'tools.file.unsupported_type' });
        assert.deepEqual(s.violations, []);
    }],

    ['a failed run throws ToolRunError (problem+json mapped); a failed job is retried with jobs.retry', async () => {
        let calls = 0;
        const s = standIn({
            tools: {
                descriptors: [jobTool('flaky')],
                handlers: {
                    flaky: async ({ progress }) => {
                        await progress(10, 'trying');
                        if (++calls === 1) throw Object.assign(new Error('The engine was busy'), { code: 'tools.flaky.busy', status: 503, retryable: true });
                        return { data: { attempt: calls } };
                    },
                },
            },
        });
        const tools = createToolsClient(s.client());

        const err = await tools.run('jsonminify', { text: '{' }).then(() => null, (e) => e);
        assert.ok(err instanceof ToolRunError && err instanceof OpenVibeError && isOpenVibeError(err) && isToolRunError(err));
        assert.equal(err.name, 'OpenVibeError');
        assert.equal(err.code, 'tools.jsonminify.invalid_json');
        assert.equal(err.status, 422, 'the problem status, not the HTTP 200');
        assert.equal(err.title, 'Unprocessable Content');
        assert.match(err.detail, /^Not valid JSON/);
        assert.equal(err.state, 'failed');
        assert.equal(err.tool, 'jsonminify');
        assert.equal(err.job, null);
        assert.equal(err.run.state, 'failed');
        assert.equal(err.problem.code, 'tools.jsonminify.invalid_json');
        assert.equal(err.retryable, false);

        const pending = await tools.run('flaky', {});
        const failed = await pending.wait().then(() => null, (e) => e);
        assert.ok(isToolRunError(failed));
        assert.equal(failed.code, 'tools.flaky.busy');
        assert.equal(failed.status, 503);
        assert.equal(failed.retryable, true);
        assert.equal(failed.job.state, 'failed');
        assert.equal(failed.job.links.retry, `/api/v1/jobs/${failed.job.id}/retry`);
        assert.equal(failed.run, null, 'it came from the job, not from a run answer');

        const again = await tools.jobs.retry(failed.job.id);
        assert.equal(again.replayed, false);
        assert.equal(again.job.retry_of, failed.job.id);
        assert.equal(again.job.tool, 'flaky');
        const twice = await tools.jobs.retry(failed.job.id);
        assert.equal(twice.replayed, true, 'asking again returns the same retry');
        assert.equal(twice.job.id, again.job.id);
        assert.deepEqual(statusOf(s, `/api/v1/jobs/${failed.job.id}/retry`), [202, 200]);
        const fixed = await tools.jobs.wait(again.job.id);
        assert.equal(fixed.state, 'succeeded');
        assert.deepEqual(fixed.result.data, { attempt: 2 });
        assert.equal((await tools.jobs.get(failed.job.id)).retried_by, again.job.id);
        await assert.rejects(tools.jobs.retry(again.job.id), { status: 409, code: 'tools.job.not_failed' });

        calls = 0;
        const direct = await tools.run('flaky', {}, { waitMs: 5000 }).then(() => null, (e) => e);
        assert.ok(isToolRunError(direct), 'failed within wait_ms: thrown from the 200 answer');
        assert.equal(direct.job.state, 'failed');
        assert.equal(direct.run.job.id, direct.job.id);
        assert.deepEqual(s.violations, []);
    }],

    ['429 with Retry-After is retried after the delay, with the same Idempotency-Key', async () => {
        let throttled = 0;
        const s = standIn({}, {
            before: async (req, url) => {
                if (!url.pathname.endsWith('/run') || throttled++) return null;
                return new Response(JSON.stringify({ type: 'https://openvibe.network/problems/quota.exceeded', title: 'Too Many Requests', status: 429, code: 'quota.exceeded', detail: 'tools-fetch: 30 per minute' }), {
                    status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '1' },
                });
            },
        });
        const tools = createToolsClient(s.anon());
        const t0 = Date.now();
        const out = await tools.run('dns', { target: 'example.com' });
        const took = Date.now() - t0;
        assert.equal(out.state, 'succeeded');
        assert.ok(took >= 900, `waited for Retry-After (${took} ms)`);
        assert.deepEqual(statusOf(s, '/api/v1/tools/dns/run'), [429, 200]);
        assert.equal(s.runs.length, 2);
        assert.equal(s.runs[0].key, s.runs[1].key);
        assert.equal(out.idempotencyKey, s.runs[0].key);

        throttled = 0;
        await assert.rejects(createToolsClient(s.anon({ retries: 0 })).run('dns', { target: 'example.com' }), { status: 429, code: 'quota.exceeded', retryable: true });
        assert.deepEqual(s.violations, []);
    }],

    ['idempotent replay: the same key gets the same job; a lost answer is retried with the same key', async () => {
        let lose = false;
        const s = standIn({}, {
            after: async (req, url, res) => {
                if (!lose || !url.pathname.endsWith('/run')) return null;
                lose = false;                 // the job was created, but its answer never arrived
                return new Response(JSON.stringify({ type: 'https://openvibe.network/problems/http.503', title: 'Service Unavailable', status: 503, code: 'upstream.unavailable' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } });
            },
        });
        const tools = createToolsClient(s.client());
        const file = { name: 'a.png', data: Buffer.from('PNG'), type: 'image/png' };
        const a = await tools.run('png', { quality: 50 }, { files: [file], idempotencyKey: 'idem_example_key_0001' });
        const b = await tools.run('png', { quality: 50 }, { files: [file], idempotencyKey: 'idem_example_key_0001' });
        assert.equal(a.replayed, false);
        assert.equal(b.replayed, true);
        assert.equal(b.job.id, a.job.id);
        assert.equal(b.idempotencyKey, 'idem_example_key_0001');
        assert.deepEqual(s.runs.map((r) => r.key), ['idem_example_key_0001', 'idem_example_key_0001']);
        assert.deepEqual(statusOf(s, '/api/v1/tools/png/run'), [202, 200]);
        await assert.rejects(tools.run('png', { quality: 60 }, { files: [file], idempotencyKey: 'idem_example_key_0001' }), { status: 409, code: 'tools.job.idempotency_conflict' });
        await assert.rejects(tools.run('png', {}, { idempotencyKey: 'short' }), TypeError);

        const before = s.platform.state.jobs.size;
        lose = true;
        const c = await tools.run('png', {}, { files: [file] });
        assert.equal(c.replayed, true, 'the retry found the job the lost answer created');
        assert.equal(s.platform.state.jobs.size, before + 1, 'one job, not two');
        const [first, second] = s.runs.slice(-2);
        assert.equal(first.key, second.key, 'the generated key is reused by the retry');
        assert.equal(first.key, c.idempotencyKey);
        assert.equal((await c.wait()).state, 'succeeded');
        assert.deepEqual(s.violations, []);
    }],

    ['abort: a signal cancels a pending run and a wait', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const s = standIn({
            tools: {
                descriptors: [syncTool('slow'), jobTool('slowjob')],
                handlers: {
                    slow: ({ signal }) => new Promise((resolve) => { const t = setTimeout(() => resolve({ data: {} }), 10000); signal.addEventListener('abort', () => { clearTimeout(t); resolve({ data: {} }); }); }),
                    slowjob: async ({ progress }) => { await progress(1, 'waiting'); await gate; return { data: {} }; },
                },
            },
        });
        const tools = createToolsClient(s.client());
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 30);
        const t0 = Date.now();
        await assert.rejects(tools.run('slow', {}, { signal: ctrl.signal }), { code: 'sdk.aborted' });
        assert.ok(Date.now() - t0 < 2000, 'aborted promptly');
        await assert.rejects(tools.run('slow', {}, { signal: AbortSignal.abort() }), { code: 'sdk.aborted' });

        const r = await tools.run('slowjob', {});
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 40);
        await assert.rejects(r.wait({ signal: stop.signal }), { code: 'sdk.aborted' });
        assert.equal((await tools.jobs.get(r.job.id)).state, 'running', 'aborting the wait leaves the job alone');
        release();
        assert.equal((await r.wait()).state, 'succeeded');
        assert.deepEqual(s.violations, []);
    }],

    ['files: { media_id } and { job_id, index } references in JSON, beside uploads in multipart', async () => {
        const s = standIn({
            tools: {
                descriptors: [jobTool('merge', { files: { min: 2, max: 5, accept: ['text/plain', 'image/*'], maxBytes: 1024 } })],
                handlers: { merge: async ({ files }) => ({ data: { parts: files.map((f) => `${f.name}:${f.bytes.toString()}`) } }) },
            },
        });
        const mid = s.platform.addMediaObject({ name: 'logo.gif', type: 'image/gif', data: 'GIF89a' });
        const tools = createToolsClient(s.client());

        const fromMedia = await (await tools.run('png', {}, { files: [{ media_id: mid }] })).wait();
        assert.deepEqual(s.runs[0].body, { input: {}, files: [{ media_id: mid }] });
        assert.equal(s.runs[0].multipart, false, 'references alone: a JSON body');
        assert.equal(fromMedia.result.files[0].name, 'logo.png');

        const chained = await (await tools.run('png', {}, { files: { job_id: fromMedia.job.id, index: 0 } })).wait();
        assert.deepEqual(s.runs[1].body, { input: {}, files: [{ job_id: fromMedia.job.id, index: 0 }] });
        assert.equal(Buffer.from(await (await tools.jobs.file(chained.job.id, 0)).arrayBuffer()).toString(), 'GIF89a', "one tool's output feeds the next");

        const merged = await (await tools.run('merge', {}, { files: [{ media_id: mid }, { name: 'a.txt', data: 'A', type: 'text/plain' }, { job_id: chained.job.id, index: 0 }], waitMs: 0 })).wait();
        const sent = s.runs[2];
        assert.equal(sent.multipart, true);
        assert.deepEqual(sent.body, { input: {}, files: [{ media_id: mid }, { job_id: chained.job.id, index: 0 }], wait_ms: 0 });
        assert.deepEqual(sent.uploads, [{ part: 'file', name: 'a.txt', type: 'text/plain', text: 'A' }]);
        assert.deepEqual(merged.result.data.parts, ['a.txt:A', 'logo.gif:GIF89a', 'logo.png:GIF89a'], 'uploads first, then the references in order');

        await assert.rejects(tools.run('png', {}, { files: [{ media_id: 'med_01K5WZX7S7Q4D2B8N3M6V1C9TR' }] }), { status: 404, code: 'tools.run.file_not_found' });
        await assert.rejects(createToolsClient(s.client(OTHER, 'o')).run('png', {}, { files: [{ job_id: chained.job.id, index: 0 }] }), { status: 404, code: 'tools.run.file_not_found' }, "another caller's job is not readable");
        await assert.rejects(tools.run('png', {}, { files: [{ job_id: chained.job.id, index: 7 }] }), { status: 404, code: 'tools.run.file_not_found' });
        for (const bad of [{ media_id: 'x' }, { job_id: chained.job.id, index: -1 }, { job_id: 'job_1', index: 0 }, { foo: 1 }, 42]) {
            await assert.rejects(tools.run('png', {}, { files: [bad] }), TypeError, JSON.stringify(bad));
        }
        assert.deepEqual(s.violations, []);
    }],
]);
