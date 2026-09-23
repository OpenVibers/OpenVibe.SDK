'use strict';
/**
 * Mock OpenVibe.Tools jobs (/api/v1/jobs), enabled with createMockPlatform({ jobs: true | {…} }).
 * Node only. Plays the documented lifecycle queued -> running -> (progress…) -> succeeded | failed
 * | cancelled, with owner scoping, Idempotency-Key replay, SSE events with ids and Last-Event-ID
 * replay, 204 once finished, and result files.
 *
 *   jobs: {
 *       stepMs: 5,                                   // delay between lifecycle steps
 *       handlers: { 'img.process': async ({ input, files, progress, cancelled }) => ({ data, files: [{ name, mime, bytes }] }) },
 *   }
 * Without a handler for a type, the job echoes: data { echo: input }, files = the uploaded files.
 * A handler that throws fails the job with { code: err.code || 'tools.job.failed', detail }.
 */
const { ulid, json, problem, sha256hex } = require('./util');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CAPS = { create: 'tools.job.create', read: 'tools.job.read', cancel: 'tools.job.cancel' };

function createJobsService(ctx) {
    const cfg = ctx.opts.jobs && typeof ctx.opts.jobs === 'object' ? ctx.opts.jobs : {};
    const stepMs = cfg.stepMs ?? 5;
    const handlers = cfg.handlers || {};
    const jobs = new Map();
    const idem = new Map();
    const streams = new Set();
    const iso = (t) => (t ? new Date(t).toISOString() : null);

    function view(job) {
        const live = job.state === 'queued' || job.state === 'running';
        return {
            id: job.id, object: 'tools.job', service: 'mock', type: job.type, type_version: 1, state: job.state,
            progress: { percent: job.percent, message: job.message }, attempts: job.state === 'queued' ? 0 : 1, max_attempts: 1,
            cancel_requested: job.cancelRequested, created_at: iso(job.createdAt), started_at: iso(job.startedAt), finished_at: iso(job.finishedAt), expires_at: null,
            result: job.result ? {
                files: job.result.files.map((f, i) => ({ name: f.name, mime: f.mime, size: f.bytes.length, url: `/api/v1/jobs/${job.id}/files/${i}` })),
                data: job.result.data || {},
            } : null,
            error: job.error, retryable: false,
            links: { self: `/api/v1/jobs/${job.id}`, events: `/api/v1/jobs/${job.id}/events`, cancel: live ? `/api/v1/jobs/${job.id}` : null },
        };
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

    async function runJob(job) {
        await new Promise((r) => setTimeout(r, stepMs));
        if (TERMINAL.has(job.state)) return;
        Object.assign(job, { state: 'running', startedAt: Date.now() });
        emit(job, 'job.running');
        const handler = handlers[job.type] || (async ({ input, files, progress }) => {
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
            if (job.cancelRequested) return finish(job, 'cancelled');
            const files = ((out && out.files) || []).map((f) => ({ name: f.name || 'result', mime: f.mime || 'application/octet-stream', bytes: Buffer.from(f.bytes || f.data || '') }));
            return finish(job, 'succeeded', { percent: 100, message: null, result: { data: (out && out.data) || {}, files } });
        } catch (err) {
            if (job.cancelRequested) return finish(job, 'cancelled');
            return finish(job, 'failed', { error: { code: (err && err.code) || 'tools.job.failed', detail: (err && err.message) || 'failed' } });
        }
    }

    /** Who owns what this request does: a principal (svc:/app:) or a Network user. */
    function owner(req, action) {
        const auth = req.headers.get('authorization') || '';
        if (!auth.startsWith('Bearer ')) return { res: problem(401, 'token.missing', 'no token') };
        const claims = ctx.decode(auth.slice(7));
        if (claims && claims.actor_type) {
            const who = ctx.principal(req, 'openvibe.tools', CAPS[action]);
            return who.res ? who : { owner: who.claims.sub };
        }
        return claims ? { owner: `user:${claims.subject_id}` } : { res: problem(401, 'token.bad_signature', 'not a valid token') };
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

    async function handle(req, url) {
        if (!ctx.opts.jobs) return problem(404, 'not_found', 'jobs are not enabled on this mock (createMockPlatform({ jobs: true }))');
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
            if (Object.keys(handlers).length && !handlers[type]) return problem(400, 'tools.job.unknown_type', `no job type ${type}`);
            const key = req.headers.get('idempotency-key');
            const hash = sha256hex(JSON.stringify([type, input, files.map((f) => sha256hex(f.bytes))]));
            if (key) {
                const prior = idem.get(`${who.owner}|${key}`);
                if (prior) {
                    if (prior.hash !== hash) return problem(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request');
                    return json(200, view(jobs.get(prior.id)), { Location: `/api/v1/jobs/${prior.id}`, 'Idempotent-Replayed': 'true', 'Cache-Control': 'no-store' });
                }
            }
            const job = {
                id: `job_${ulid()}`, owner: who.owner, type, input, files, state: 'queued', percent: null, message: null,
                cancelRequested: false, createdAt: Date.now(), startedAt: null, finishedAt: null, result: null, error: null, events: [],
            };
            jobs.set(job.id, job);
            if (key) idem.set(`${who.owner}|${key}`, { id: job.id, hash });
            emit(job, 'job.queued');
            runJob(job);
            return json(202, view(job), { Location: `/api/v1/jobs/${job.id}`, 'Cache-Control': 'no-store' });
        }
        if ((m = path.match(/^\/api\/v1\/jobs\/([^/]+)(\/events|\/files\/(\d+))?$/))) {
            const action = req.method === 'DELETE' ? 'cancel' : 'read';
            if (!['GET', 'DELETE'].includes(req.method) || (req.method === 'DELETE' && m[2])) return problem(405, 'method_not_allowed', 'method not allowed');
            const who = owner(req, action);
            if (who.res) return who.res;
            const job = jobs.get(decodeURIComponent(m[1]));
            if (!job || job.owner !== who.owner) return problem(404, 'tools.job.not_found', 'No such job');
            if (req.method === 'DELETE') {
                if (job.state === 'succeeded' || job.state === 'failed') return problem(409, 'tools.job.already_finished', `The job already ${job.state}`);
                if (job.state === 'queued') finish(job, 'cancelled');
                else if (job.state === 'running' && !job.cancelRequested) { job.cancelRequested = true; emit(job, 'job.cancel_requested'); }
                return json(job.state === 'cancelled' ? 200 : 202, view(job), { 'Cache-Control': 'no-store' });
            }
            if (!m[2]) return json(200, view(job), { 'Cache-Control': 'no-store' });
            if (m[3] !== undefined) {
                if (job.state !== 'succeeded') return problem(409, 'tools.job.not_ready', `The job is ${job.state}`);
                const f = job.result.files[Number(m[3])];
                if (!f) return problem(404, 'tools.job.file_not_found', 'No such result file');
                const kind = ['1', 'true'].includes(url.searchParams.get('inline') || '') ? 'inline' : 'attachment';
                return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.mime, 'Content-Disposition': `${kind}; filename="${f.name.replace(/["\\]/g, '_')}"`, 'Cache-Control': 'private, no-store' } });
            }
            const raw = req.headers.get('last-event-id') ?? url.searchParams.get('last_event_id');
            const after = Math.max(0, parseInt(raw, 10) || 0);
            if (TERMINAL.has(job.state) && !job.events.some((e) => e.seq > after)) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
            return stream(req, job, after);
        }
        return problem(404, 'not_found', 'Not found');
    }

    return {
        handle,
        jobs,
        /** End every open job event stream (clients reconnect with Last-Event-ID). */
        dropStreams() { for (const s of [...streams]) s.close(); },
    };
}

module.exports = { createJobsService, JOB_CAPS: CAPS };
