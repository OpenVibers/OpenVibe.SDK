'use strict';
/**
 * openvibe-sdk/ai: OpenVibe.AI's run API (roadmap WS-F task 4). For first-party services (a Network
 * service token with ai.run.create / ai.run.read, audience openvibe.ai) and developer apps granted
 * them; workflows are namespaced by product (a caller may only run the namespaces it was granted).
 *
 *   const ai = createAiClient(client);
 *   const { run } = await ai.runs.create('live.stream.describe_frame', { image_url }, { wait: 20000 });
 *   const { run } = await ai.runs.create('blog.write_digest', { items }, { latency: 'background' });
 *   const done = run.status === 'succeeded' ? run : await ai.runs.waitFor(run.id);
 *   const summary = await ai.summarize({ text }, { wait: 30000 });   // ai.summarize, waited for
 *
 * A run may ask for the class it may wait in: { latency: 'interactive' | 'background' | 'batch' } and, for
 * a batch run, { deadlineHours: 1..72 } (how long the answer may take). The class belongs to the workflow:
 * a caller may ask for a slower class and never for a faster one, and a faster ask is clamped, not refused
 * — the run answers with the class it really ran in (run.latency_class), the tier it was priced on
 * (run.service_tier) and, when it was clamped, the class it was asked for (run.latency_clamped).
 *
 * create() answers { run } with 201 (finished within the wait, or served from cache), 202 (still queued
 * or running: poll get() or use waitFor()), or 200 (an idempotent replay: `replayed: true`). Pass an
 * idempotencyKey so a retried create never runs twice; creates are otherwise not retried. A quota
 * refusal or a full queue is a 429 error carrying Retry-After.
 *
 * ai.batches is the other door into AI: a batch is many prompts answered later, at half the retail
 * price (POST /api/v1/batches, GET /api/v1/batches, GET /api/v1/batches/:id, POST
 * /api/v1/batches/:id/cancel). The answers are not waited for: the batch says where it stands.
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const OPS = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed'];
const CLASSES = ['interactive', 'background', 'batch'];

function createAiClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const call = (opts, o = {}) => client.json({ service: 'ai', baseUrl, audience: 'openvibe.ai', ...opts, signal: o.signal });
    const writeOpts = (o) => (o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : { idempotencyKey: false });
    const waitQuery = (o) => (o.wait != null ? { wait: Math.max(0, Math.floor(o.wait)) } : undefined);
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    // The options a run carries: what the caller asks for (options.latency: interactive, background or
    // batch) and, for a batch run, how long the answer may take (options.deadline_hours: 1 to 72). A caller
    // may ask for a slower class than the workflow allows and never for a faster one; a faster ask is
    // clamped by the service and the run says so (run.latency_clamped).
    const runOptions = (o) => {
        if (o.latency == null && o.deadlineHours == null) return o.options;
        const options = { ...(o.options || {}) };
        if (o.latency != null) options.latency = o.latency;
        if (o.deadlineHours != null) options.deadline_hours = o.deadlineHours;
        return options;
    };

    const runs = {
        /** workflow key (e.g. 'wiki.generate_page'), its input; o: { wait (ms), version, idempotencyKey, target, attribution, onBehalfOf, latency, deadlineHours, options } */
        create(workflow, input = {}, o = {}) {
            const body = { workflow, input };
            if (o.choice !== undefined) body.choice = o.choice;
            if (o.task !== undefined) body.task = o.task;
            if (o.version != null) body.version = o.version;
            if (o.target !== undefined) body.target = o.target;
            if (o.attribution !== undefined) body.attribution = o.attribution;
            if (o.onBehalfOf !== undefined) body.on_behalf_of = o.onBehalfOf;
            const options = runOptions(o);
            if (options !== undefined) body.options = options;
            return call({ method: 'POST', path: '/api/v1/runs', query: waitQuery(o), json: body, ...writeOpts(o) }, o);
        },
        list: (query = {}, o = {}) => call({ path: '/api/v1/runs', query }, o),
        get: (id, o = {}) => orNull(call({ path: `/api/v1/runs/${enc(id)}` }, o)),
        cancel: (id, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/cancel`, idempotencyKey: false }, o),
        retry: (id, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/retry`, query: waitQuery(o), ...writeOpts(o) }, o),
        citations: (id, o = {}) => call({ path: `/api/v1/runs/${enc(id)}/citations` }, o),
        addCitations: (id, citations, o = {}) => call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/citations`, json: { citations }, idempotencyKey: false }, o),
        /**
         * Poll get() until the run finishes (succeeded, failed or cancelled) or `timeoutMs` passes. → the run
         *
         * A run of the batch class may take hours. When the wait is over and the run is a batch run, the
         * pending run is returned instead of an error: its status says where it stands (queued, running).
         * The answer comes later, with the run's completion event (ai.run.succeeded) or the webhook the run
         * was made with — a caller that wants the answer in hand reads it there, not from a wait.
         */
        async waitFor(id, { intervalMs = 1000, timeoutMs = 120000, signal } = {}) {
            const until = Date.now() + timeoutMs;
            for (;;) {
                const got = await runs.get(id, { signal });
                const run = got && (got.run || got);
                if (!run) throw new Error(`run ${id} not found`);
                if (TERMINAL.has(run.status)) return run;
                if (Date.now() + intervalMs > until) {
                    // A batch run is not late: it may take hours. The pending run is the answer for now.
                    if (run.latency_class === 'batch') return run;
                    throw new Error(`run ${id} still ${run.status} after ${timeoutMs} ms`);
                }
                await new Promise((r) => setTimeout(r, intervalMs));
                if (signal && signal.aborted) throw new Error('aborted');
            }
        },
    };

    const tasks = (o = {}) => call({ path: '/api/v1/tasks' }, o);
    /** What AI can make (GET /api/v1/creations; public, cached, CORS open) → { creations, count, generated_at } */
    const creations = (o = {}) => call({ path: '/api/v1/creations', auth: false }, o);
    const choices = {
        get: (task, o = {}) => call({ path: '/api/v1/choices', query: { task } }, o),
        set: (task, choice, o = {}) => call({ method: 'PUT', path: `/api/v1/me/choices/${enc(task)}`, json: choice, idempotencyKey: false }, o),
    };
    const run = (task, input = {}, o = {}) => {
        const body = { task, input, ...(o.choice ? { choice: o.choice } : {}), ...(o.onBehalfOf ? { on_behalf_of: o.onBehalfOf } : {}), ...(runOptions(o) ? { options: runOptions(o) } : {}) };
        return call({ method: 'POST', path: '/api/v1/runs', query: waitQuery(o), json: body, ...writeOpts(o) }, o);
    };
    const admin = { defaults: (value, o = {}) => call({ path: '/api/v1/admin/task-defaults', ...(value === undefined ? {} : { method: 'PUT', json: value, idempotencyKey: false }) }, o) };

    const batches = {
        /** The prompts of a batch (a string, or { prompt, model }); o: { model, deadlineHours, idempotencyKey } → { batch } */
        create(items, o = {}) {
            const body = { items };
            if (o.model != null) body.model = o.model;
            if (o.deadlineHours != null) body.deadline_hours = o.deadlineHours;
            return call({ method: 'POST', path: '/api/v1/batches', json: body, ...writeOpts(o) }, o);
        },
        /** The caller's own batches, newest first → { batches } */
        list: (query = {}, o = {}) => call({ path: '/api/v1/batches', query }, o),
        /** One batch with its items → { batch } (null when there is no such batch) */
        get: (id, o = {}) => orNull(call({ path: `/api/v1/batches/${enc(id)}` }, o)),
        /**
         * Cancel a batch → { batch }
         *
         * Only the prompts that never had a run are cancelled, and nothing is charged for them. A prompt
         * that already has a run (the provider is working on it) goes on and settles on its own path: it
         * keeps its status, the answer says so, and nobody is told it was not charged.
         */
        cancel: (id, o = {}) => call({ method: 'POST', path: `/api/v1/batches/${enc(id)}/cancel`, idempotencyKey: false }, o),
    };

    // Files live in Media; turns carry only their Media object references.
    const fileObjects = defaults.objectsClient || (defaults.media ? require('./objects').createObjectsClient(defaults.media) : null);
    const requireFiles = (method) => { if (!fileObjects) throw new TypeError(`ai.files.${method}: configure defaults.media or defaults.objectsClient`); };
    const files = {
        async attach(data, { filename, mediaType, subject, signal, ...options } = {}) {
            requireFiles('attach');
            const owner = subject || (defaults.media && defaults.media.subject);
            if (!owner) throw new TypeError('ai.files.attach: subject (the person who may read this file) is required');
            // Unlisted, not listed anywhere, and readable by its (unguessable) Media id: the AI service reads a
            // turn's file by reference from Media's public bytes URL, which a private object would refuse. A caller
            // that has a Media read path of its own may pass visibility: 'private' and send the read result instead.
            const obj = await fileObjects.upload(data, { kind: 'file', visibility: 'unlisted', filename, mimeType: mediaType, subject: owner, signal, ...options });
            return { id: obj.id, name: obj.filename || filename || 'file', media_type: obj.mime_type || mediaType || 'application/octet-stream', size: obj.size_bytes,
                storage: { provider: 'media', key: obj.id }, access: { readers: [owner] },
                read: { method: 'not_readable', reason: 'File is attached; AI has not read it yet.' }, role: 'input' };
        },
        async list(options = {}) {
            requireFiles('list');
            const page = await fileObjects.list({ kind: 'file', ...options });
            return { ...page, files: (page.objects || []).map((obj) => ({ id: obj.id, name: obj.filename, media_type: obj.mime_type, size: obj.size_bytes,
                storage: { provider: 'media', key: obj.id }, access: { readers: [obj.owner_id].filter(Boolean) },
                read: { method: 'not_readable', reason: 'Read this file to obtain its contents.' }, role: 'input' })) };
        },
        async read(id, { ttl = 300, signal } = {}) {
            requireFiles('read');
            const fetchImpl = defaults.fetch || globalThis.fetch;
            // A signed URL is the private read path. An unlisted object (an attached file, or an artifact in
            // another tenant's namespace) is also served by its public bytes URL, so a caller without a Media
            // read grant for that tenant can still read it by its unguessable med_… id.
            let url = null;
            try { url = (await fileObjects.signedUrl(id, { ttl })).url; } catch { url = null; }
            let response = url ? await fetchImpl(url, { signal }) : null;
            if (!response || !response.ok) {
                const base = String((defaults.media && defaults.media.baseUrl) || (typeof fileObjects.baseUrl === 'function' ? await fileObjects.baseUrl() : '')).replace(/\/+$/, '');
                if (!base) throw new Error(`ai.files.read: Media answered ${response ? response.status : 'no signed URL'}`);
                response = await fetchImpl(`${base}/o/${enc(id)}`, { signal });
            }
            if (!response.ok) throw new Error(`ai.files.read: Media answered ${response.status}`);
            return { file: await fileObjects.get(id), bytes: new Uint8Array(await response.arrayBuffer()) };
        },
        remove(id) { requireFiles('remove'); return fileObjects.delete(id); },
    };

    const api = { tasks, creations, choices, run, admin, runs, batches, files, TERMINAL, CLASSES };
    // Direct operations: a run of workflow ai.<op> with the input as the body, waited for by AI.
    for (const op of OPS) {
        api[op] = (input = {}, o = {}) => call({ method: 'POST', path: `/api/v1/${op}`, query: waitQuery(o),
            json: { ...input, ...(o.target !== undefined ? { target: o.target } : {}), ...(o.attribution !== undefined ? { attribution: o.attribution } : {}), ...(runOptions(o) !== undefined ? { options: runOptions(o) } : {}) },
            ...writeOpts(o) }, o);
    }
    return api;
}

module.exports = { createAiClient, TERMINAL, OPS, CLASSES };
