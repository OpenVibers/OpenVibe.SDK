'use strict';
/**
 * openvibe-sdk/tools: the OpenVibe.Tools platform API (ADR-027) on the gateway, https://openvibe.tools:
 * the tool registry, the uniform run API, and the jobs client for tools that run as jobs.
 * Browser-safe.
 *
 *   const tools = createToolsClient(client);
 *   const { tools: list } = await tools.list({ family: 'img', api: true });
 *   const png = await tools.get('png');                          // tools.tool@1, or null
 *   const out = await tools.run('jsonminify', { text: '{ "a": 1 }' });
 *   out.result.text;                                             // an inline tool: finished
 *   const run = await tools.run('png', {}, { files: [{ name: 'a.jpg', data: bytes }] });
 *   run.state;                                                   // a job tool: 'queued', with run.job, run.location
 *   const done = await run.wait();                               // { state: 'succeeded', result: { files, data }, job }
 *   const res = await tools.jobs.file(done.job.id, 0);           // raw Response
 *
 * Routes (audience openvibe.tools):
 *   GET  /api/v1/tools[?family&execution&api&status&q]  tools.tool-list@1 (schemas as $ref)   tools.tool.read,
 *   GET  /api/v1/tools/:id                               tools.tool@1 (schemas embedded)       public and
 *   GET  /api/v1/tools/:id/schema                        { $schema, $id, $defs: { input, output } }  anonymous
 *   POST /api/v1/tools/:id/run                           tools.run-request@1 -> tools.run@1:   tools.tool.run
 *        200 finished (succeeded, or failed/cancelled with the tool's own problem), 202 + Location
 *        while a job is queued or running; tools.net.probe for network probes (partner)
 *   /api/v1/jobs…                                        the gateway's jobs facade (openvibe-sdk/jobs)
 *
 * Callers are tiered anonymous < session < user < app/service. A client without a token runs the
 * tools whose descriptor has auth.anonymous true; a person's token runs every tool but the probes; an
 * app or service token needs auth.capability (tools.tool.run, or tools.net.probe). Registry reads
 * send no token unless `anonymousReads: false`.
 */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { newIdempotencyKey } = require('./core/ids');
const { isUpload, appendFiles } = require('./core/form');
const { createJobsClient } = require('./jobs');

const enc = encodeURIComponent;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MEDIA_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_WAIT_MS = 60000;
/** Time on top of wait_ms (or a tool's limits.timeoutMs) for the request itself. */
const RUN_MARGIN_MS = 10000;

/**
 * A run that finished `failed` or `cancelled`: the tool's own problem+json, mapped like any other
 * OpenVibeError (code, status, title, detail, type, errors, requestId, traceId). `status` is the
 * problem's status (422, 504…), not the HTTP status of the answer (200). Also: `state`, `tool`,
 * `job` (tools.job@1 when the tool ran as a job: `jobs.retry(err.job.id)` when `retryable`) and `run`
 * (the tools.run@1 answer, when there was one).
 */
class ToolRunError extends OpenVibeError {
    constructor({ state, tool, error, job = null, run = null, requestId, traceId } = {}) {
        const p = error && typeof error === 'object' ? error : {};
        const code = typeof p.code === 'string' && p.code ? p.code : state === 'cancelled' ? 'tools.job.cancelled' : 'tools.job.failed';
        const detail = typeof p.detail === 'string' ? p.detail : null;
        super({
            message: `tools.run ${tool} ${state}: ${code}${detail ? `: ${detail}` : ''}`,
            code,
            status: Number.isInteger(p.status) ? p.status : 0,
            title: typeof p.title === 'string' ? p.title : undefined,
            detail: detail || undefined,
            type: typeof p.type === 'string' ? p.type : undefined,
            errors: Array.isArray(p.errors) ? p.errors : undefined,
            problem: typeof p.code === 'string' && typeof p.status === 'number' ? p : null,
            requestId: p.request_id || requestId,
            traceId: p.trace_id || traceId,
            retryable: Boolean(job && job.retryable),
        });
        this.state = state;
        this.tool = tool;
        this.job = job || null;
        this.run = run || null;
    }
}

/** A run that finished failed or cancelled (a ToolRunError, also from another copy of the SDK). */
function isToolRunError(err) {
    return err instanceof ToolRunError
        || Boolean(isOpenVibeError(err) && typeof err.tool === 'string' && (err.state === 'failed' || err.state === 'cancelled') && 'job' in err);
}

function checkId(id, where) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`${where}: a tool id is lowercase letters, digits and dashes (png, jsonminify, dns)`);
}

/** A files reference of tools.run-request@1, normalized to exactly its fields; null for an upload. */
function asRef(f) {
    if (!f || typeof f !== 'object' || isUpload(f)) return null;
    if (f.media_id !== undefined) {
        if (typeof f.media_id !== 'string' || !MEDIA_ID_RE.test(f.media_id)) throw new TypeError('tools.run: media_id is a Media object id (med_<ULID>)');
        return { media_id: f.media_id };
    }
    if (f.job_id !== undefined) {
        if (typeof f.job_id !== 'string' || !JOB_ID_RE.test(f.job_id)) throw new TypeError('tools.run: job_id is a Tools job id (job_<ULID>)');
        if (!Number.isInteger(f.index) || f.index < 0 || f.index > 99) throw new TypeError('tools.run: a job file reference needs index, 0..99');
        return { job_id: f.job_id, index: f.index };
    }
    throw new TypeError('tools.run: a file is an upload (Blob/File, or { name, data, type? }) or a reference ({ media_id } or { job_id, index })');
}

const tookMs = (job) => {
    const a = Date.parse(job && job.created_at);
    const b = Date.parse(job && job.finished_at);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
};

/**
 * createToolsClient(client, { baseUrl, service = 'tools', audience = 'openvibe.tools', anonymousReads = true })
 *   -> { list, get, schema, run, jobs }
 *
 * Without `baseUrl` the gateway is the `tools` service origin from the platform descriptor.
 * `jobs` is openvibe-sdk/jobs on the same origin and credentials (the gateway's jobs facade).
 */
function createToolsClient(client, { baseUrl, service = 'tools', audience = 'openvibe.tools', anonymousReads = true } = {}) {
    const call = (opts) => client.request({ service, baseUrl, audience, ...opts });
    const read = (path, query, signal) => call({ path, query, signal, ...(anonymousReads ? { auth: false } : {}) }).then((r) => r.data);
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const jobs = createJobsClient(client, { baseUrl, service, audience });
    const limits = new Map();       // id -> limits.timeoutMs, from descriptors this client has read
    const remember = (d) => { if (d && d.id && d.limits && Number.isInteger(d.limits.timeoutMs)) limits.set(d.id, d.limits.timeoutMs); };

    /**
     * The registry: tools.tool-list@1 { tools, count, updated_at, families } with every descriptor's
     * schemas as { $ref }. Filters: family, execution ('client' | 'sync' | 'job'), api (boolean), status, q.
     */
    async function list({ family, q, execution, api, status, signal } = {}) {
        const query = { family, q, execution, status, api: api === undefined || api === null ? undefined : String(Boolean(api)) };
        const out = await read('/api/v1/tools', query, signal);
        if (out && Array.isArray(out.tools)) out.tools.forEach(remember);
        return out;
    }

    /** One descriptor (tools.tool@1, schemas embedded), or null when there is no such tool. */
    async function get(id, { signal } = {}) {
        checkId(id, 'tools.get');
        const d = await orNull(read(`/api/v1/tools/${enc(id)}`, undefined, signal));
        remember(d);
        return d;
    }

    /** { $schema, $id, $defs: { input, output } } (what the list's $refs point at), or null. */
    async function schema(id, { signal } = {}) {
        checkId(id, 'tools.schema');
        return orNull(read(`/api/v1/tools/${enc(id)}/schema`, undefined, signal));
    }

    const hide = (obj, name, value) => Object.defineProperty(obj, name, { value, enumerable: false, configurable: true, writable: true });

    function succeeded({ tool, result, took_ms, job, location, meta }) {
        const out = { state: 'succeeded', tool, result: result || {}, took_ms: Number.isFinite(took_ms) ? took_ms : 0 };
        if (job) {
            out.job = job;
            out.location = location || (job.links && job.links.self) || `/api/v1/jobs/${job.id}`;
        }
        out.idempotencyKey = meta.idempotencyKey;
        out.replayed = Boolean(meta.replayed);
        return hide(out, 'wait', async () => out);
    }

    /** A finished job as the run it belongs to: succeeded, or a thrown ToolRunError. */
    function fromJob(job, tool, meta) {
        if (!job) throw new OpenVibeError({ code: 'tools.job.not_found', status: 404, message: `tools.run ${tool}: the job is gone (expired, or not yours)` });
        if (job.state === 'succeeded') {
            const r = job.result || { files: [], data: {} };
            return succeeded({ tool, result: { data: r.data || {}, files: r.files || [] }, took_ms: tookMs(job), job, location: job.links && job.links.self, meta });
        }
        if (job.state === 'failed' || job.state === 'cancelled') throw new ToolRunError({ state: job.state, tool, error: job.error, job });
        return pending({ state: job.state, tool, job, location: job.links && job.links.self, meta });
    }

    function pending({ state, tool, job, location, meta }) {
        const out = { state, tool, job, location: location || (job.links && job.links.self) || `/api/v1/jobs/${job.id}`, idempotencyKey: meta.idempotencyKey, replayed: Boolean(meta.replayed) };
        return hide(out, 'wait', async (opts = {}) => fromJob(await jobs.wait(job.id, opts), tool, meta));
    }

    /** A tools.run@1 answer (or a bare tools.job@1) -> the resolved value, or a thrown ToolRunError. */
    function settle(body, tool, meta) {
        if (body && body.object === 'tools.job') return fromJob(body, tool, meta);      // a server that answers with the job itself
        if (!body || typeof body !== 'object' || typeof body.state !== 'string') {
            throw new OpenVibeError({ code: 'sdk.bad_response', status: meta.status, requestId: meta.requestId, traceId: meta.traceId, message: `tools.run ${tool}: the answer is not a tools.run@1 run` });
        }
        const name = body.tool || tool;
        if (body.state === 'queued' || body.state === 'running') {
            if (!body.job || !body.job.id) throw new OpenVibeError({ code: 'sdk.bad_response', status: meta.status, message: `tools.run ${tool}: ${body.state} without its job` });
            return pending({ state: body.state, tool: name, job: body.job, location: body.location || meta.location, meta });
        }
        if (body.state === 'succeeded') return succeeded({ tool: name, result: body.result, took_ms: body.took_ms, job: body.job || null, location: body.location || meta.location, meta });
        if (body.state === 'failed' || body.state === 'cancelled') {
            throw new ToolRunError({ state: body.state, tool: name, error: body.error || (body.job && body.job.error), job: body.job || null, run: body, requestId: meta.requestId, traceId: meta.traceId });
        }
        throw new OpenVibeError({ code: 'sdk.bad_response', status: meta.status, message: `tools.run ${tool}: unknown state ${body.state}` });
    }

    /**
     * run(id, input = {}, { files, waitMs, idempotencyKey, signal, timeoutMs })
     *   -> { state: 'succeeded', tool, result: { data | text | files }, took_ms, job?, location?, idempotencyKey, replayed }
     *    | { state: 'queued' | 'running', tool, job, location, idempotencyKey, replayed }
     * Every resolved run has a non-enumerable `wait(opts)`: a finished run resolves to itself; a job
     * follows the job's events (jobs.wait, same options: signal, onEvent, lastEventId) and resolves
     * to the succeeded run, or throws ToolRunError.
     *
     * - files: uploads (Blob/File, or { name, data, type? }, sent as multipart `file` parts) and
     *   references ({ media_id } a Media object you may read; { job_id, index } a result file of your
     *   own job), in that order. References go in the JSON body's `files`, or, beside uploads, as a
     *   multipart `files` part holding their JSON.
     * - waitMs: a job tool waits up to this long (0..60000) before answering; 200 finished, else 202.
     * - idempotencyKey: generated when omitted (returned). The same key and request give the same
     *   job (`replayed: true`); another request under it is 409 tools.job.idempotency_conflict. The
     *   key also makes the POST safe to retry: 429 (Retry-After) and 5xx are retried by the client.
     * - timeoutMs: per attempt. Default: the client's, raised to waitMs, or to the tool's
     *   limits.timeoutMs once this client has read its descriptor (get or list), plus 10 s.
     * A request refused before the tool ran (404 tools.tool.not_found | not_runnable, 422
     * tools.input.invalid, 403 capability.denied, 503 tools.tool.unavailable…) throws OpenVibeError.
     */
    async function run(id, input = {}, { files, waitMs, idempotencyKey, signal, timeoutMs } = {}) {
        checkId(id, 'tools.run');
        if (input == null) input = {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('tools.run: input must be an object');
        if (waitMs != null && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS)) throw new TypeError(`tools.run: waitMs is an integer, 0..${MAX_WAIT_MS}`);
        const list = files == null ? [] : Array.isArray(files) ? files : [files];
        const refs = [];
        const uploads = [];
        for (const f of list) {
            const ref = asRef(f);
            if (ref) refs.push(ref);
            else if (isUpload(f)) uploads.push(f);
            else throw new TypeError('tools.run: a file is an upload (Blob/File, or { name, data, type? }) or a reference ({ media_id } or { job_id, index })');
        }
        if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !/^[!-~]{8,200}$/.test(idempotencyKey))) {
            throw new TypeError('tools.run: idempotencyKey is 8-200 printable ASCII characters');
        }
        const key = idempotencyKey || newIdempotencyKey();

        const opts = { method: 'POST', path: `/api/v1/tools/${enc(id)}/run`, idempotencyKey: key, signal };
        if (uploads.length) {
            const form = new FormData();
            form.append('input', JSON.stringify(input));
            if (refs.length) form.append('files', JSON.stringify(refs));
            if (waitMs != null) form.append('wait_ms', String(waitMs));
            opts.form = appendFiles(form, uploads, 'tools.run');
        } else {
            const body = { input };
            if (refs.length) body.files = refs;
            if (waitMs != null) body.wait_ms = waitMs;
            opts.json = body;
        }
        const base = client.options || {};
        const floor = Math.max(waitMs || 0, limits.get(id) || 0);
        opts.timeoutMs = timeoutMs ?? Math.max(base.timeoutMs || 0, floor ? floor + RUN_MARGIN_MS : 0);
        opts.deadlineMs = Math.max(base.deadlineMs || 0, opts.timeoutMs * 2);

        const res = await call(opts);
        return settle(res.data, id, {
            idempotencyKey: key,
            replayed: String(res.headers.get('idempotent-replayed') || '') === 'true',
            location: res.headers.get('location') || undefined,
            status: res.status,
            requestId: res.requestId,
            traceId: res.traceId,
        });
    }

    return { list, get, schema, run, jobs };
}

module.exports = { createToolsClient, ToolRunError, isToolRunError };
