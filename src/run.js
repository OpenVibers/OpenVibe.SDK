'use strict';
/**
 * openvibe-sdk/run — OpenVibe.Run for services and apps: run a job on a worker node (a machine that offers
 * worker:<class>, placed by Run and dispatched through Bot), follow it and cancel it. Routes at
 * https://openvibe.run/api/v1; tokens for audience openvibe.run that name a project (the job is the project's; a
 * first-party service acting for a person names the project with X-OV-Project, see `forProject`).
 *
 *   const run = createRunClient(createClient({ tokenProvider }));
 *   const { job } = await run.jobs.submit({ class: 'function', artifact: { name: 'thumbnailer', version: '1.2.0' }, args: { width: 320 }, limits: { wall_ms: 120000, cpu_ms: 60000, mem_bytes: 512e6 } });
 *   for await (const e of run.jobs.events(job.id)) console.log(e.event, e.data);   // until the job's `end` event
 *   const { jobs, next_cursor } = await run.jobs.list({ state: 'running' });
 *   await run.jobs.cancel(job.id);                                                  // a request: cancelled once the node stops
 *   const { stream_url } = await run.jobs.streamTicket(job.id);                     // a two-minute, one-use URL for a browser's EventSource
 *
 * submit carries an Idempotency-Key (Run answers a repeat with the first job, 200), so it is retried safely; pass
 * idempotency_key in the body to choose it. Cancelling asks the node to stop; the job reaches `cancelled` when it has.
 * Errors are OpenVibeError: run.invalid_request (400), run.project_required (403), run.job_not_found (404, also for
 * another project's job), run.idempotency.conflict (409), run.args_too_large (413), run.limits.exceeded,
 * run.invalid_input (422), run.stream.busy / run.stream.disabled (503), …
 */
const { parseSSE } = require('./realtime');

const enc = encodeURIComponent;
const JOB_ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;      // Run's own rule
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATES = ['queued', 'placed', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

function createRunClient(client, { baseUrl, project } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') throw new TypeError('createRunClient: pass an openvibe-sdk/core client');
    if (project != null && !PROJECT_RE.test(String(project))) throw new TypeError('createRunClient: project is a prj_ id');
    const at = { service: 'run', baseUrl, audience: 'openvibe.run', ...(project ? { headers: { 'X-OV-Project': String(project) } } : {}) };
    const call = (opts) => client.json({ ...at, ...opts, headers: { ...(at.headers || {}), ...(opts.headers || {}) } });
    const job = (v) => {
        if (!JOB_ID_RE.test(String(v || ''))) throw new TypeError('run: a job is a job_ id');
        return enc(String(v));
    };

    /**
     * The job's events as they happen (SSE run.job-stream-event@1: { id, event, data }), replayed after lastEventId
     * first; it ends with the job's `end` event, after which Run closes the stream. Needs run.job.stream.
     */
    async function* events(jobId, { lastEventId = 0, signal } = {}) {
        const res = await client.request({
            ...at, path: `/api/v1/jobs/${job(jobId)}/stream`, responseType: 'response', retries: 0, signal,
            headers: { ...(at.headers || {}), Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': String(Number(lastEventId) || 0) },
        });
        for await (const msg of parseSSE(res.data.body)) {
            let data = null;
            try { data = JSON.parse(msg.data); } catch { data = msg.data; }
            const n = Number(msg.id);
            yield { id: Number.isFinite(n) && msg.id !== undefined && msg.id !== '' ? n : null, event: msg.event, data };
            if (msg.event === 'end') return;
        }
    }

    return {
        jobs: {
            /** Submit a job (run.job-create-request@1: class and limits required) → { job } (201, or 200 for a repeat). */
            submit: (body, { idempotencyKey, signal } = {}) => {
                if (!body || typeof body.class !== 'string' || !body.limits) throw new TypeError('run.jobs.submit: class and limits are required');
                const key = idempotencyKey || body.idempotency_key;
                return call({ method: 'POST', path: '/api/v1/jobs', json: body, ...(key ? { idempotencyKey: String(key) } : {}), signal });
            },
            /** The project's jobs, newest first: { jobs, next_cursor }. */
            list: ({ state, limit, cursor, signal } = {}) => {
                if (state != null && !STATES.includes(state)) throw new TypeError(`run.jobs.list: state is one of ${STATES.join(', ')}`);
                return call({ path: '/api/v1/jobs', query: { state, limit, cursor }, signal });
            },
            get: (jobId, { signal } = {}) => call({ path: `/api/v1/jobs/${job(jobId)}`, signal }),
            /** Ask the job to stop; asking twice is harmless. */
            cancel: (jobId, { signal } = {}) => call({ method: 'POST', path: `/api/v1/jobs/${job(jobId)}/cancel`, idempotent: true, signal }),
            /** A one-use ticket for a browser: { ticket, expires_at, expires_in, stream_url, job_id }. */
            streamTicket: (jobId, { signal } = {}) => call({ method: 'POST', path: `/api/v1/jobs/${job(jobId)}/stream/ticket`, idempotent: true, signal }),
            events,
        },
        /** The same client for a project named by X-OV-Project (a first-party service acting for one of its admins). */
        forProject: (p) => createRunClient(client, { baseUrl, project: p }),
    };
}

module.exports = { createRunClient, RUN_JOB_STATES: STATES };
