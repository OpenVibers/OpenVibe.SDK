'use strict';
/**
 * openvibe-sdk/ai: OpenVibe.AI's run API (roadmap WS-F task 4). For first-party services (a Network
 * service token with ai.run.create / ai.run.read, audience openvibe.ai) and developer apps granted
 * them; workflows are namespaced by product (a caller may only run the namespaces it was granted).
 *
 *   const ai = createAiClient(client);
 *   const { run } = await ai.runs.create('live.stream.describe_frame', { image_url }, { wait: 20000 });
 *   const done = run.status === 'succeeded' ? run : await ai.runs.waitFor(run.id);
 *   const summary = await ai.summarize({ text }, { wait: 30000 });   // ai.summarize, waited for
 *
 * create() answers { run } with 201 (finished within the wait, or served from cache), 202 (still queued
 * or running: poll get() or use waitFor()), or 200 (an idempotent replay: `replayed: true`). Pass an
 * idempotencyKey so a retried create never runs twice; creates are otherwise not retried. A quota
 * refusal or a full queue is a 429 error carrying Retry-After.
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed'];

function createAiClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const call = (opts, o = {}) => client.json({ service: 'ai', baseUrl, audience: 'openvibe.ai', ...opts, signal: o.signal });
    const writeOpts = (o) => (o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : { idempotencyKey: false });
    const waitQuery = (o) => (o.wait != null ? { wait: Math.max(0, Math.floor(o.wait)) } : undefined);
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });

    const runs = {
        /** workflow key (e.g. 'wiki.generate_page'), its input; o: { wait (ms), version, idempotencyKey, target, attribution, onBehalfOf, options } */
        create(workflow, input = {}, o = {}) {
            const body = { workflow, input };
            if (o.version != null) body.version = o.version;
            if (o.target !== undefined) body.target = o.target;
            if (o.attribution !== undefined) body.attribution = o.attribution;
            if (o.onBehalfOf !== undefined) body.on_behalf_of = o.onBehalfOf;
            if (o.options !== undefined) body.options = o.options;
            return call({ method: 'POST', path: '/api/v1/runs', query: waitQuery(o), json: body, ...writeOpts(o) }, o);
        },
        list: (query = {}, o = {}) => call({ path: '/api/v1/runs', query }, o),
        get: (id, o = {}) => orNull(call({ path: `/api/v1/runs/${enc(id)}` }, o)),
        cancel: (id, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/cancel`, idempotencyKey: false }, o),
        retry: (id, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/retry`, query: waitQuery(o), ...writeOpts(o) }, o),
        citations: (id, o = {}) => call({ path: `/api/v1/runs/${enc(id)}/citations` }, o),
        addCitations: (id, citations, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/citations`, json: { citations }, idempotencyKey: false }, o),
        /** Poll get() until the run finishes (succeeded, failed or cancelled) or `timeoutMs` passes. → the run */
        async waitFor(id, { intervalMs = 1000, timeoutMs = 120000, signal } = {}) {
            const until = Date.now() + timeoutMs;
            for (;;) {
                const got = await runs.get(id, { signal });
                const run = got && (got.run || got);
                if (!run) throw new Error(`run ${id} not found`);
                if (TERMINAL.has(run.status)) return run;
                if (Date.now() + intervalMs > until) throw new Error(`run ${id} still ${run.status} after ${timeoutMs} ms`);
                await new Promise((r) => setTimeout(r, intervalMs));
                if (signal && signal.aborted) throw new Error('aborted');
            }
        },
    };

    const api = { runs, TERMINAL };
    // Direct operations: a run of workflow ai.<op> with the input as the body, waited for by AI.
    for (const op of OPS) {
        api[op] = (input = {}, o = {}) => call({ method: 'POST', path: `/api/v1/${op}`, query: waitQuery(o),
            json: { ...input, ...(o.target !== undefined ? { target: o.target } : {}), ...(o.attribution !== undefined ? { attribution: o.attribution } : {}), ...(o.options !== undefined ? { options: o.options } : {}) },
            ...writeOpts(o) }, o);
    }
    return api;
}

module.exports = { createAiClient, TERMINAL, OPS };
