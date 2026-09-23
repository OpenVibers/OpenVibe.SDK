'use strict';
/**
 * Mock OpenVibe.Tools jobs (/api/v1/jobs), enabled with createMockPlatform({ jobs: true | {…} })
 * (also by { tools }). Node only. Plays the documented lifecycle queued -> running -> (progress…) ->
 * succeeded | failed | cancelled, with owner scoping, Idempotency-Key replay, SSE events with ids and
 * Last-Event-ID replay, 204 once finished, result files, retry of a failed job and result references.
 * Every answer is a tools.job@1 view (openvibe-contracts v0.33.0).
 *
 *   jobs: {
 *       stepMs: 5,                                   // delay between lifecycle steps
 *       handlers: { 'img.process': async ({ input, files, progress, cancelled }) => ({ data, files: [{ name, mime, bytes }] }) },
 *   }
 * Every Tools origin of the platform answers (origins.tools and the img., audio. and docs.
 * satellites). A satellite keeps its own jobs: a job id is found only on the origin that created it.
 * origins.tools is the gateway's facade (ADR-027): it also sees every satellite's jobs, and a job
 * created through it is also found on the satellite its type names (img.process -> img.).
 * Without a handler for a type, the job echoes: data { echo: input }, files = the uploaded files.
 * A handler that throws fails the job with problem+json: code err.code when it is a tools.… code
 * (else tools.job.failed), status err.status (else 422), retryable err.retryable.
 */
const { ulid, json, problem, sha256hex } = require('./util');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CAPS = { create: 'tools.job.create', read: 'tools.job.read', cancel: 'tools.job.cancel' };
const REF_RE = /^[a-z][a-z0-9_-]*(?::[A-Za-z0-9_.-]+){1,4}$/;
const MAX_REFS = 50;
const TTL_MS = 24 * 3600 * 1000;
const TITLES = { 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** A problem+json body (errors.problem@1), as the job's `error` and a failed run's `error`. */
function problemBody(status, code, detail, extra = {}) {
    return { type: `https://openvibe.network/problems/${code}`, title: TITLES[status] || 'Error', status, code, detail, error: detail, ...extra };
}

function createJobsService(ctx) {
    const cfg = ctx.opts.jobs && typeof ctx.opts.jobs === 'object' ? ctx.opts.jobs : {};
    const stepMs = cfg.stepMs ?? 5;
    const handlers = cfg.handlers || {};
    const gateway = new URL(ctx.gateway || 'https://openvibe.tools').origin;
    const jobs = new Map();
    const idem = new Map();
    const streams = new Set();
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const label = (origin) => new URL(origin).hostname.split('.')[0];

    /** A satellite's label (img, audio, docs) when the job runs there; 'mock' otherwise. */
    function serviceOf(job) {
        if (job.origin !== gateway) return label(job.origin);
        const prefix = String(job.type).split('.')[0];
        return /^[a-z][a-z0-9-]{1,39}$/.test(prefix) && String(job.type).includes('.') ? prefix : 'mock';
    }
    /** Found here? Its own origin; the gateway sees all; a satellite sees gateway jobs of its type. */
    function visibleAt(job, origin) {
        return origin === job.origin || origin === gateway || (job.origin === gateway && label(origin) === serviceOf(job));
    }

    function view(job) {
        const live = job.state === 'queued' || job.state === 'running';
        const self = `/api/v1/jobs/${job.id}`;
        const out = {
            id: job.id, object: 'tools.job', service: serviceOf(job),
        };
        if (job.tool) out.tool = job.tool;
        Object.assign(out, {
            type: job.type, type_version: 1, state: job.state,
            progress: { percent: job.percent, message: job.message }, attempts: job.state === 'queued' ? 0 : 1, max_attempts: 1,
            cancel_requested: job.cancelRequested, created_at: iso(job.createdAt), started_at: iso(job.startedAt), finished_at: iso(job.finishedAt),
            expires_at: job.references.length ? null : iso(job.createdAt + TTL_MS),
            result: job.result ? {
                files: job.result.files.map((f, i) => ({ name: f.name, mime: f.mime, size: f.bytes.length, sha256: sha256hex(f.bytes), storage: 'local', media: null, url: `${self}/files/${i}` })),
                data: job.result.data || {},
            } : null,
            error: job.error, retryable: Boolean(job.retryable), retry_of: job.retryOf || null, retried_by: job.retriedBy || null,
            references: job.references.map((r) => ({ ref: r.ref, created_at: iso(r.at) })),
            links: {
                self, events: `${self}/events`, cancel: live ? self : null,
                retry: job.state === 'failed' ? `${self}/retry` : null,
                retried_by: job.retriedBy ? `/api/v1/jobs/${job.retriedBy}` : null,
            },
        });
        return out;
    }

    function emit(job, event) {
        const e = { seq: job.events.length + 1, event, data: view(job) };
        job.events.push(e);
        for (const s of [...streams]) if (s.jobId === job.id) s.push(e);
    }

    function finish(job, state, fields = {}) {
        if (TERMINAL.has(job.state)) return;
        Object.assign(job, { state, finishedAt: Date.now() }, fields);
        emit(job, `job.${state}`);
    }
    const cancelledError = () => problemBody(409, 'tools.job.cancelled', 'The job was cancelled');

    async function runJob(job) {
        await new Promise((r) => setTimeout(r, stepMs));
        if (TERMINAL.has(job.state)) return;
        Object.assign(job, { state: 'running', startedAt: Date.now() });
        emit(job, 'job.running');
        const handler = job.handler || handlers[job.type] || (async ({ input, files, progress }) => {
            await progress(50, 'working');
            return { data: { echo: input }, files: files.map((f) => ({ name: f.name, mime: f.type, bytes: f.bytes })) };
        });
        try {
            const out = await handler({
                input: job.input,
                files: job.files,
                progress: async (percent, message = null) => {
                    await new Promise((r) => setTimeout(r, stepMs));
                    if (TERMINAL.has(job.state)) return;
                    Object.assign(job, { percent, message });
                    emit(job, 'job.progress');
                },
                get cancelled() { return job.cancelRequested; },
            });
            await new Promise((r) => setTimeout(r, stepMs));
            if (job.cancelRequested) return finish(job, 'cancelled', { error: cancelledError() });
            const files = ((out && out.files) || []).map((f) => ({ name: f.name || 'result', mime: f.mime || 'application/octet-stream', bytes: Buffer.from(f.bytes || f.data || '') }));
            return finish(job, 'succeeded', { percent: 100, message: null, result: { data: (out && out.data) || {}, files } });
        } catch (err) {
            if (job.cancelRequested) return finish(job, 'cancelled', { error: cancelledError() });
            const code = /^tools\.[a-z0-9_.]+$/.test(String((err && err.code) || '')) ? err.code : 'tools.job.failed';
            const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 422;
            return finish(job, 'failed', { error: problemBody(status, code, (err && err.message) || 'The tool could not process this input'), retryable: Boolean(err && err.retryable) });
        }
    }

    /**
     * Create a job (the POST route, and the tools mock's job runs) -> { job, replayed } | { res }.
     * files: [{ name, type, bytes }]; handler overrides the type's handler; tool names the tool run.
     */
    function create({ origin, owner, env = 'production', type, input, files = [], key = null, hash = null, handler = null, tool = null, retryOf = null }) {
        if (!handler && Object.keys(handlers).length && !handlers[type]) return { res: problem(400, 'tools.job.unknown_type', `no job type ${type}`) };
        if (key) {
            const prior = idem.get(`${origin}|${owner}|${key}`);
            if (prior) {
                if (prior.hash !== hash) return { res: problem(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request') };
                return { job: jobs.get(prior.id), replayed: true };
            }
        }
        const job = {
            id: `job_${ulid()}`, origin, owner, env, type, input, files, handler, tool, state: 'queued', percent: null, message: null,
            cancelRequested: false, createdAt: Date.now(), startedAt: null, finishedAt: null, result: null, error: null, retryable: false,
            retryOf, retriedBy: null, references: [], events: [],
        };
        jobs.set(job.id, job);
        if (key) idem.set(`${origin}|${owner}|${key}`, { id: job.id, hash });
        emit(job, 'job.queued');
        runJob(job);
        return { job, replayed: false };
    }

    /** Who owns what this request does: a principal (svc:/app:) or a Network user. */
    function owner(req, action) {
        const auth = req.headers.get('authorization') || '';
        if (!auth.startsWith('Bearer ')) return { res: problem(401, 'token.missing', 'no token') };
        const claims = ctx.decode(auth.slice(7));
        if (claims && claims.actor_type) {
            const who = ctx.principal(req, 'openvibe.tools', CAPS[action]);
            return who.res ? who : { owner: who.claims.sub, env: who.claims.env === 'sandbox' ? 'sandbox' : 'production' };
        }
        return claims ? { owner: `user:${claims.subject_id}`, env: 'production' } : { res: problem(401, 'token.bad_signature', 'not a valid token') };
    }

    function stream(req, job, after) {
        const enc = new TextEncoder();
        let conn;
        const body = new ReadableStream({
            start(controller) {
                const close = () => { streams.delete(conn); try { controller.close(); } catch { /* closed */ } };
                conn = {
                    jobId: job.id,
                    last: after,
                    push(e) {
                        if (e.seq <= conn.last) return;
                        conn.last = e.seq;
                        try { controller.enqueue(enc.encode(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)); } catch { streams.delete(conn); return; }
                        if (TERMINAL.has(e.data.state) && e.event !== 'job.progress') setImmediate(close);
                    },
                    close,
                };
                controller.enqueue(enc.encode(`retry: ${stepMs}\n\n`));
                streams.add(conn);
                for (const e of job.events) conn.push(e);
                if (req.signal) req.signal.addEventListener('abort', close, { once: true });
            },
            cancel() { streams.delete(conn); },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    const noStore = { 'Cache-Control': 'no-store' };
    /** The caller's job at this origin, or { res } (404 for anyone else's, like a missing one). */
    function load(req, url, id, action) {
        const who = owner(req, action);
        if (who.res) return who;
        const job = jobs.get(decodeURIComponent(id));
        if (!job || job.owner !== who.owner || !visibleAt(job, url.origin)) return { res: problem(404, 'tools.job.not_found', 'No such job') };
        return { job };
    }

    function retry(job) {
        if (job.retriedBy) return { job: jobs.get(job.retriedBy), replayed: true };
        if (job.state !== 'failed') return { res: problem(409, 'tools.job.not_failed', `Only failed jobs can be retried; this one is ${job.state}`, { state: job.state }) };
        const next = create({ origin: job.origin, owner: job.owner, env: job.env, type: job.type, input: job.input, files: job.files, handler: job.handler, tool: job.tool, retryOf: job.id });
        if (next.res) return next;
        job.retriedBy = next.job.id;
        return next;
    }

    async function handle(req, url) {
        if (!ctx.opts.jobs && !ctx.opts.tools) return problem(404, 'not_found', 'jobs are not enabled on this mock (createMockPlatform({ jobs: true }))');
        const path = url.pathname;
        let m;
        if (path === '/api/v1/jobs' && req.method === 'POST') {
            const who = owner(req, 'create');
            if (who.res) return who.res;
            let type, input, files = [];
            const ct = req.headers.get('content-type') || '';
            if (ct.startsWith('multipart/form-data')) {
                const form = await req.formData();
                type = String(form.get('type') || '');
                try { input = JSON.parse(String(form.get('input') || '{}')); } catch { return problem(400, 'tools.job.invalid', 'input must be JSON'); }
                for (const f of [...form.getAll('file'), ...form.getAll('files')]) {
                    if (typeof f !== 'string') files.push({ name: f.name, type: f.type || 'application/octet-stream', bytes: Buffer.from(await f.arrayBuffer()) });
                }
            } else {
                const b = await req.json().catch(() => null);
                if (!b) return problem(400, 'tools.job.invalid', 'send JSON { type, input } or multipart');
                type = String(b.type || '');
                input = b.input == null ? {} : b.input;
            }
            if (!type) return problem(400, 'tools.job.invalid', 'type is required');
            if (!input || typeof input !== 'object' || Array.isArray(input)) return problem(400, 'tools.job.invalid', 'input must be a JSON object');
            const key = req.headers.get('idempotency-key');
            const hash = sha256hex(JSON.stringify([type, input, files.map((f) => sha256hex(f.bytes))]));
            const out = create({ origin: url.origin, owner: who.owner, env: who.env, type, input, files, key, hash });
            if (out.res) return out.res;
            const headers = { Location: `/api/v1/jobs/${out.job.id}`, ...noStore, ...(out.replayed ? { 'Idempotent-Replayed': 'true' } : {}) };
            return json(out.replayed ? 200 : 202, view(out.job), headers);
        }
        if ((m = path.match(/^\/api\/v1\/jobs\/([^/]+)\/retry$/))) {
            if (req.method !== 'POST') return problem(405, 'method_not_allowed', 'method not allowed');
            const got = load(req, url, m[1], 'create');
            if (got.res) return got.res;
            const out = retry(got.job);
            if (out.res) return out.res;
            return json(out.replayed ? 200 : 202, view(out.job), { Location: `/api/v1/jobs/${out.job.id}`, ...noStore, ...(out.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
        }
        if ((m = path.match(/^\/api\/v1\/jobs\/([^/]+)\/references\/([^/]+)$/))) {
            if (req.method !== 'PUT' && req.method !== 'DELETE') return problem(405, 'method_not_allowed', 'method not allowed');
            const got = load(req, url, m[1], 'create');
            if (got.res) return got.res;
            const { job } = got;
            const ref = decodeURIComponent(m[2]);
            if (!REF_RE.test(ref) || ref.length > 200) return problem(400, 'tools.job.invalid', 'A reference is <service>:<kind>:<id>, e.g. community:paste:p_123 (at most 200 characters)');
            const has = job.references.some((r) => r.ref === ref);
            if (req.method === 'DELETE') {
                job.references = job.references.filter((r) => r.ref !== ref);
                return json(200, view(job), noStore);
            }
            if (job.state !== 'succeeded') return problem(409, 'tools.job.not_succeeded', `Only a succeeded job's result can be referenced; this one is ${job.state}`, { state: job.state });
            if (job.env === 'sandbox') return problem(409, 'tools.job.sandbox', 'Sandbox results are kept briefly and cannot be referenced');
            if (!has && job.references.length >= MAX_REFS) return problem(409, 'tools.job.too_many_references', `At most ${MAX_REFS} references per job`);
            if (!has) job.references.push({ ref, at: Date.now() });
            return json(has ? 200 : 201, view(job), noStore);
        }
        if ((m = path.match(/^\/api\/v1\/jobs\/([^/]+)(\/events|\/files\/(\d+))?$/))) {
            const action = req.method === 'DELETE' ? 'cancel' : 'read';
            if (!['GET', 'DELETE'].includes(req.method) || (req.method === 'DELETE' && m[2])) return problem(405, 'method_not_allowed', 'method not allowed');
            const got = load(req, url, m[1], action);
            if (got.res) return got.res;
            const { job } = got;
            if (req.method === 'DELETE') {
                if (job.state === 'succeeded' || job.state === 'failed') return problem(409, 'tools.job.already_finished', `The job already ${job.state}`);
                if (job.state === 'queued') finish(job, 'cancelled', { error: problemBody(409, 'tools.job.cancelled', 'The job was cancelled before it started') });
                else if (job.state === 'running' && !job.cancelRequested) { job.cancelRequested = true; emit(job, 'job.cancel_requested'); }
                return json(job.state === 'cancelled' ? 200 : 202, view(job), noStore);
            }
            if (!m[2]) return json(200, view(job), noStore);
            if (m[3] !== undefined) {
                if (job.state !== 'succeeded') return problem(409, 'tools.job.not_ready', `The job is ${job.state}`);
                const f = job.result.files[Number(m[3])];
                if (!f) return problem(404, 'tools.job.file_not_found', 'No such result file');
                const kind = ['1', 'true'].includes(url.searchParams.get('inline') || '') ? 'inline' : 'attachment';
                return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.mime, 'Content-Disposition': `${kind}; filename="${f.name.replace(/["\\]/g, '_')}"`, 'Cache-Control': 'private, no-store' } });
            }
            const raw = req.headers.get('last-event-id') ?? url.searchParams.get('last_event_id');
            const after = Math.max(0, parseInt(raw, 10) || 0);
            if (TERMINAL.has(job.state) && !job.events.some((e) => e.seq > after)) return new Response(null, { status: 204, headers: noStore });
            return stream(req, job, after);
        }
        return problem(404, 'not_found', 'Not found');
    }

    return {
        handle,
        jobs,
        create,
        view,
        owner,
        /** End every open job event stream (clients reconnect with Last-Event-ID). */
        dropStreams() { for (const s of [...streams]) s.close(); },
    };
}

module.exports = { createJobsService, problemBody, JOB_CAPS: CAPS, TERMINAL_JOB_STATES: TERMINAL };
