'use strict';
/**
 * openvibe-sdk/jobs: asynchronous jobs on OpenVibe.Tools (/api/v1/jobs on each satellite that runs
 * jobs: img, audio, docs). Browser-safe; the credentials decide who owns a job.
 *
 *   const jobs = createJobsClient(client, { baseUrl: 'https://img.openvibe.tools' });
 *   const { job } = await jobs.submit({ type: 'img.process', input: { tool: 'convert', format: 'webp' },
 *                                       files: [{ name: 'a.png', data: bytes }], idempotencyKey });
 *   for await (const e of jobs.events(job.id, { lastEventId: saved })) save(e.id);   // reattaches after drops
 *   const done = await jobs.get(job.id);
 *   const res = await jobs.file(job.id, 0);          // raw Response: stream or save it
 *
 * Capabilities (audience openvibe.tools): tools.job.create (submit), tools.job.read (get, events,
 * file), tools.job.cancel (cancel). Jobs are owner-scoped: another principal gets 404, the same
 * answer as for a job that does not exist.
 *
 *   POST   /api/v1/jobs                JSON { type, input } or multipart (type, input, file…);
 *                                      Idempotency-Key -> 202 new | 200 + Idempotent-Replayed
 *   GET    /api/v1/jobs/:id
 *   DELETE /api/v1/jobs/:id            cancel -> 200 cancelled | 202 cancel requested | 409 finished
 *   GET    /api/v1/jobs/:id/events     SSE with ids; Last-Event-ID replays only later events;
 *                                      204 when the job finished and nothing is newer
 *   GET    /api/v1/jobs/:id/files/:n   a result file
 */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { newIdempotencyKey } = require('./core/ids');
const { parseSSE } = require('./realtime');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_EVENTS = new Set(['job.succeeded', 'job.failed', 'job.cancelled']);
const enc = encodeURIComponent;
const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function toBlob(data, type) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data], type ? { type } : undefined);
    throw new TypeError('jobs.submit: a file is a Blob/File, or { name, data: Blob | ArrayBuffer | typed array | string, type? }');
}

/** Is this job finished (succeeded, failed or cancelled)? */
function isTerminal(job) {
    return Boolean(job && TERMINAL.has(job.state));
}

function createJobsClient(client, { baseUrl, service = 'tools', audience = 'openvibe.tools' } = {}) {
    const call = (opts) => client.request({ service, baseUrl, audience, ...opts });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });

    /**
     * submit({ type, input = {}, files, idempotencyKey, signal }) -> { job, replayed, idempotencyKey }
     *
     * Always carries an Idempotency-Key (one is generated when you pass none), so retries after a
     * timeout or a 503 are safe. To survive a crash between submitting and saving the job id, derive
     * the key from the request (or store it first) and submit again with the same key: Tools answers
     * with the SAME job (`replayed: true`). A different request under a used key is 409
     * tools.job.idempotency_conflict.
     */
    async function submit({ type, input = {}, files, idempotencyKey, signal } = {}) {
        if (!type) throw new TypeError('jobs.submit: type is required (e.g. img.process)');
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('jobs.submit: input must be an object');
        const key = idempotencyKey || newIdempotencyKey();
        const list = files == null ? [] : Array.isArray(files) ? files : [files];
        const opts = { method: 'POST', path: '/api/v1/jobs', idempotencyKey: key, signal };
        if (list.length) {
            const form = new FormData();
            form.append('type', String(type));
            form.append('input', JSON.stringify(input));
            for (const f of list) {
                const isBlob = typeof Blob !== 'undefined' && f instanceof Blob;
                const blob = isBlob ? f : toBlob(f && f.data, f && f.type);
                form.append('file', blob, (isBlob ? f.name : f && f.name) || 'file');
            }
            opts.form = form;
        } else {
            opts.json = { type: String(type), input };
        }
        const res = await call(opts);
        return { job: res.data, replayed: String(res.headers.get('idempotent-replayed') || '') === 'true', idempotencyKey: key };
    }

    /** The job, or null when it does not exist or is not yours. */
    async function get(id, { signal } = {}) {
        const res = await orNull(call({ path: `/api/v1/jobs/${enc(id)}`, signal }));
        return res ? res.data : null;
    }

    /**
     * Cancel -> the job (state `cancelled`, or `cancel_requested: true` while it is running).
     * A finished job answers 409 tools.job.already_finished (thrown).
     */
    async function cancel(id, { signal } = {}) {
        return (await call({ method: 'DELETE', path: `/api/v1/jobs/${enc(id)}`, signal })).data;
    }

    /**
     * events(id, { lastEventId = 0, signal, maxReconnects = 20, reconnectDelayMs = 1000 })
     *   -> async iterator of { id, event, job }
     *
     * Follows the job's SSE stream until the job finishes. When the connection drops it reconnects
     * with Last-Event-ID = the last id it yielded, so every event arrives once and in order; a 204
     * (finished, nothing newer) ends the iteration. Keep `id` somewhere durable and pass it back as
     * `lastEventId` to reattach after a restart. 4xx answers (401 after one token refresh, 403,
     * 404) are thrown; network errors and 5xx reconnect, up to maxReconnects in a row.
     */
    async function* events(id, { lastEventId = 0, signal, maxReconnects = 20, reconnectDelayMs = 1000 } = {}) {
        let last = Number(lastEventId) || 0;
        let retryMs = reconnectDelayMs;
        let failures = 0;
        while (!(signal && signal.aborted)) {
            let res;
            let delivered = false;
            try {
                res = await call({
                    path: `/api/v1/jobs/${enc(id)}/events`, responseType: 'response', retries: 0, signal,
                    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': String(last) },
                });
                if (res.status === 204) return;
                for await (const msg of parseSSE(res.data.body, { onRetry: (ms) => { retryMs = ms; } })) {
                    let job = null;
                    try { job = JSON.parse(msg.data); } catch { job = null; }
                    const n = Number(msg.id);
                    if (Number.isFinite(n) && msg.id !== undefined && msg.id !== '') {
                        if (n <= last) continue;                    // already yielded before a reconnect
                        last = n;
                    }
                    delivered = true;
                    failures = 0;
                    yield { id: Number.isFinite(n) ? n : null, event: msg.event, job };
                    if (TERMINAL_EVENTS.has(msg.event) || (job && isTerminal(job) && msg.event !== 'job.progress')) return;
                }
            } catch (err) {
                if (signal && signal.aborted) return;
                if (isOpenVibeError(err) && err.status >= 400 && err.status < 500) throw err;
                if (!isOpenVibeError(err) && !(err && (err.name === 'TypeError' || err.name === 'AbortError'))) throw err;
            }
            if (!delivered) failures++;
            if (failures > maxReconnects) {
                throw new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: `jobs: the event stream of ${id} failed ${failures} times in a row` });
            }
            await sleep(retryMs, signal);
        }
    }

    /**
     * wait(id, { lastEventId, signal, onEvent }) -> the finished job (GET after the terminal event).
     * onEvent({ id, event, job }) sees every event, e.g. to save `id` and show progress.
     */
    async function wait(id, { onEvent, ...opts } = {}) {
        for await (const e of events(id, opts)) if (onEvent) await onEvent(e);
        return get(id, { signal: opts.signal });
    }

    /**
     * A result file as the raw fetch Response (body unread): stream it, or
     * `Buffer.from(await res.arrayBuffer())`. 409 tools.job.not_ready until the job succeeded.
     */
    async function file(id, n = 0, { signal, inline = false } = {}) {
        return (await call({ path: `/api/v1/jobs/${enc(id)}/files/${Number(n)}`, query: { inline }, responseType: 'response', signal })).data;
    }

    return { submit, get, cancel, events, wait, file };
}

module.exports = { createJobsClient, isTerminal, TERMINAL_STATES: [...TERMINAL] };
