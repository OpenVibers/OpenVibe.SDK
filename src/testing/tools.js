'use strict';
/**
 * Mock OpenVibe.Tools platform API (ADR-027) on origins.tools, enabled with
 * createMockPlatform({ tools: true | {…} }). Node only. Answers as openvibe-contracts v0.33.0 says:
 *
 *   GET  /api/v1/tools[?family&execution&api&status&q]  tools.tool-list@1 (schemas as $ref)
 *   GET  /api/v1/tools/:id                               tools.tool@1 (schemas embedded)
 *   GET  /api/v1/tools/:id/schema                        { $schema, $id, $defs: { input, output } }
 *   POST /api/v1/tools/:id/run                           tools.run-request@1 (JSON or multipart) -> tools.run@1
 *
 *   tools: {
 *       descriptors: [tools.tool@1, …],     // added to the defaults (same id: replaced)
 *       handlers: { [toolId]: async (ctx) => … },
 *       mediaObjects: { 'med_…': { name, type, data } },   // what { media_id } references read
 *   }
 *
 * Handlers: an inline tool (execution client or sync) gets { input, files, caller, signal } and returns
 * { data } (output kind json) or { text } (kind text); a string is text. A job tool's handler is its
 * job's handler: { input (with the preset and operation applied), files, progress, cancelled } ->
 * { data, files: [{ name, mime, bytes }] }. A handler that throws finishes the run `failed` with
 * problem+json (err.code when it is a tools.… code, else tools.job.failed; err.status, else 422).
 *
 * The defaults: dns (sync, egress, anonymous), jsonminify (a client tool with a server engine), png
 * (a job: img.process convert to PNG), port (a probe: tools.net.probe), yt (page-only, api false)
 * and protectpdf (unavailable). Callers: no token runs tools with auth.anonymous true, except job
 * tools (the mock has no browser sessions, so a job needs a token to have an owner); a person's
 * token runs every tool but probes; app and service tokens need auth.capability for audience
 * openvibe.tools. Not modelled: quotas and 429s (wrap platform.fetch for those), byte sniffing
 * (accept is checked against the part's declared type), limits other than files.maxBytes.
 */
const { ulid, json, problem, sha256hex } = require('./util');
const { problemBody, TERMINAL_JOB_STATES } = require('./jobs');

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MEDIA_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const FAMILY_NAMES = { net: 'Network', dev: 'Developer', img: 'Images', audio: 'Audio', docs: 'Documents', text: 'Text', media: 'Media', places: 'Places', pastes: 'Pastes' };
const RUN_FIELDS = new Set(['input', 'files', 'wait_ms', 'idempotency_key']);

/** Descriptor defaults of the mock (valid tools.tool@1; schemas embedded, the list $refs them). */
function defaultDescriptors() {
    const base = (id, family, name, summary, extra) => ({
        id, family, name, summary, status: 'stable', execution: 'sync', api: true,
        run: { method: 'POST', path: `/api/v1/tools/${id}/run`, job: null },
        input: { type: 'object', additionalProperties: false, properties: {} }, files: null, output: { kind: 'json', schema: { type: 'object' } },
        limits: { timeoutMs: 10000 }, auth: { anonymous: true, capability: 'tools.tool.run' }, quotaClass: 'tools-run', cost: 1, egress: false,
        hosts: [`${id}.openvibe.tools`], docs: `https://openvibe.tools/tool/${id}`, ...extra,
    });
    return [
        base('dns', 'net', 'DNS Lookup', 'Look up A, AAAA, MX, TXT, NS and CNAME records for a domain.', {
            run: { method: 'POST', path: '/api/v1/tools/dns/run', job: null, legacy: ['GET /api/net/dns/:target'] },
            input: { type: 'object', required: ['target'], additionalProperties: false, properties: { target: { type: 'string', minLength: 1, maxLength: 253 }, type: { enum: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'] } } },
            output: { kind: 'json', schema: { type: 'object', required: ['target', 'type', 'records'], properties: { target: { type: 'string' }, type: { type: 'string' }, records: { type: 'array' } } } },
            limits: { timeoutMs: 10000, maxInputBytes: 1024, perTargetPerMinute: 30 }, quotaClass: 'tools-fetch', egress: true,
        }),
        base('jsonminify', 'dev', 'JSON Minifier', 'Strip the whitespace out of JSON.', {
            execution: 'client',
            input: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 1048576 } } },
            output: { kind: 'text' }, limits: { timeoutMs: 5000, maxInputBytes: 1048576 },
            hosts: ['json-minifier.openvibe.tools', 'jsonminify.openvibe.tools'],
        }),
        base('png', 'img', 'PNG Converter', 'Convert JPG, WebP, AVIF, GIF, BMP, TIFF and more to PNG.', {
            execution: 'job',
            run: { method: 'POST', path: '/api/v1/tools/png/run', job: { type: 'img.process', operation: 'convert', preset: { format: 'png' } }, legacy: ['POST /api/process', 'POST /api/process/direct'] },
            input: { type: 'object', additionalProperties: false, properties: { quality: { type: 'integer', minimum: 1, maximum: 100 } } },
            files: { min: 1, max: 1, accept: ['image/*'], maxBytes: 52428800 },
            output: { kind: 'file', mime: ['image/png'] }, limits: { timeoutMs: 120000, maxPixels: 100000000 },
            auth: { anonymous: false, capability: 'tools.tool.run' }, quotaClass: 'tools-job', cost: 5,
        }),
        base('port', 'net', 'Port Checker', 'Check whether TCP ports on a host are open.', {
            status: 'beta',
            run: { method: 'POST', path: '/api/v1/tools/port/run', job: null, legacy: ['GET /api/net/port/:target'] },
            input: { type: 'object', required: ['host', 'ports'], additionalProperties: false, properties: { host: { type: 'string', maxLength: 253 }, ports: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'integer', minimum: 1, maximum: 65535 } } } },
            output: { kind: 'json', schema: { type: 'object', properties: { results: { type: 'array' } } } },
            limits: { timeoutMs: 15000, perTargetPerMinute: 6 }, auth: { anonymous: false, capability: 'tools.net.probe' }, quotaClass: 'tools-probe', cost: 5, egress: true,
        }),
        base('yt', 'media', 'YouTube Downloader', 'Save a YouTube video or its audio.', {
            execution: 'job', api: false, run: null, input: null, output: { kind: 'file', mime: ['video/mp4', 'audio/mpeg'] },
            limits: { timeoutMs: 900000, maxDurationSec: 3600, perTargetPerMinute: 20 }, quotaClass: 'tools-download', cost: 50, egress: true,
            hosts: ['youtube-downloader.openvibe.tools', 'yt.openvibe.tools'],
        }),
        base('protectpdf', 'docs', 'Protect PDF', 'Put a password on a PDF (AES-256).', {
            status: 'unavailable', statusReason: 'Needs qpdf on the host; not deployed yet.', execution: 'job',
            run: { method: 'POST', path: '/api/v1/tools/protectpdf/run', job: { type: 'docs.process', operation: 'protect' } },
            input: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 128 } } },
            files: { min: 1, max: 1, accept: ['application/pdf'], maxBytes: 104857600 }, output: { kind: 'file', mime: ['application/pdf'] },
            limits: { timeoutMs: 300000, maxPages: 2000 }, auth: { anonymous: false, capability: 'tools.tool.run' }, quotaClass: 'tools-job', cost: 10,
        }),
    ];
}

/** Handlers of the default tools: deterministic, never on the network. */
function defaultHandlers() {
    return {
        dns: async ({ input }) => {
            const type = input.type || 'A';
            const records = { A: ['192.0.2.1'], AAAA: ['2001:db8::1'], MX: [`10 mail.${input.target}`], TXT: ['v=spf1 -all'], NS: [`ns1.${input.target}`], CNAME: [] }[type];
            return { data: { target: input.target, type, records } };
        },
        jsonminify: async ({ input }) => {
            try { return { text: JSON.stringify(JSON.parse(input.text)) }; } catch (err) {
                throw Object.assign(new Error(`Not valid JSON: ${err.message}`), { code: 'tools.jsonminify.invalid_json', status: 422 });
            }
        },
        png: async ({ files, progress }) => {
            await progress(50, 'Converting');
            return { data: { format: 'png' }, files: files.map((f) => ({ name: `${String(f.name || 'image').replace(/\.[^.]*$/, '')}.png`, mime: 'image/png', bytes: f.bytes })) };
        },
        port: async ({ input }) => ({ data: { results: input.ports.map((port) => ({ host: input.host, port, open: false })) } }),
    };
}

/** A minimal check of an object's top-level fields against an input schema -> [{ path, message }]. */
function checkInput(schema, input) {
    const errors = [];
    if (!schema || typeof schema !== 'object' || schema.$ref) return errors;
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in input)) errors.push({ path: `/${k}`, message: 'is required' });
    for (const [k, v] of Object.entries(input)) {
        const p = props[k];
        if (!p) {
            if (schema.additionalProperties === false) errors.push({ path: `/${k}`, message: 'is not a field of this tool' });
            continue;
        }
        const type = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
        if (p.type && !(p.type === type || (p.type === 'number' && type === 'integer'))) errors.push({ path: `/${k}`, message: `must be ${p.type}` });
        else if (p.enum && !p.enum.includes(v)) errors.push({ path: `/${k}`, message: `must be one of ${p.enum.join(', ')}` });
        else if (typeof v === 'string' && ((p.minLength && v.length < p.minLength) || (p.maxLength && v.length > p.maxLength))) errors.push({ path: `/${k}`, message: 'has the wrong length' });
        else if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) errors.push({ path: `/${k}`, message: 'is out of range' });
        else if (Array.isArray(v) && ((p.minItems && v.length < p.minItems) || (p.maxItems && v.length > p.maxItems))) errors.push({ path: `/${k}`, message: 'has the wrong number of items' });
    }
    return errors;
}

const accepts = (accept, type) => !type || accept.some((a) => a === type || (a.endsWith('/*') && type.startsWith(a.slice(0, -1))));

function createToolsService(ctx) {
    const cfg = ctx.opts.tools && typeof ctx.opts.tools === 'object' ? ctx.opts.tools : {};
    const jobsCfg = ctx.opts.jobs && typeof ctx.opts.jobs === 'object' ? ctx.opts.jobs : {};
    const stepMs = cfg.stepMs ?? jobsCfg.stepMs ?? 5;
    const gateway = new URL(ctx.origins.tools).origin;
    const tools = new Map();
    const handlers = { ...defaultHandlers(), ...(cfg.handlers || {}) };
    const media = new Map(Object.entries(cfg.mediaObjects || {}));
    const runKeys = new Map();        // `${owner}|${key}` -> { jobId, hash }
    let updatedAt = new Date().toISOString();
    const clone = (x) => JSON.parse(JSON.stringify(x));

    function addTool(d, handler) {
        if (!d || typeof d !== 'object' || !ID_RE.test(String(d.id || ''))) throw new TypeError('mock platform: a tool descriptor needs an id (lowercase letters, digits, dashes)');
        tools.set(d.id, clone(d));
        if (typeof handler === 'function') handlers[d.id] = handler;
        updatedAt = new Date().toISOString();
        return tools.get(d.id);
    }
    for (const d of defaultDescriptors()) tools.set(d.id, d);
    for (const d of cfg.descriptors || []) addTool(d);

    const schemaUrl = (id) => `${gateway}/api/v1/tools/${id}/schema`;
    /** The list form: embedded schemas become { $ref } to GET /api/v1/tools/:id/schema. */
    function listForm(d) {
        const out = clone(d);
        if (out.input && !out.input.$ref) out.input = { $ref: `${schemaUrl(d.id)}#/$defs/input` };
        if (out.output.schema && !out.output.schema.$ref) out.output.schema = { $ref: `${schemaUrl(d.id)}#/$defs/output` };
        return out;
    }

    function list(url) {
        const q = url.searchParams;
        const api = q.get('api');
        const text = (q.get('q') || '').trim().toLowerCase();
        const items = [...tools.values()].filter((d) => (!q.get('family') || d.family === q.get('family'))
            && (!q.get('execution') || d.execution === q.get('execution'))
            && (!q.get('status') || d.status === q.get('status'))
            && (api === null || d.api === ['true', '1'].includes(api))
            && (!text || [d.id, d.name, d.summary, d.family].some((s) => String(s).toLowerCase().includes(text))));
        const families = [...new Set(items.map((d) => d.family))].map((id) => ({ id, name: FAMILY_NAMES[id] || id[0].toUpperCase() + id.slice(1), count: items.filter((d) => d.family === id).length }));
        return json(200, { tools: items.map(listForm), count: items.length, updated_at: updatedAt, families }, { 'Cache-Control': 'public, max-age=60' });
    }

    /** Who runs this tool: { owner, tier } or { res } (401/403 as the gateway answers). */
    function caller(req, d) {
        const auth = req.headers.get('authorization') || '';
        if (!auth) {
            if (d.auth.anonymous && d.execution !== 'job') return { owner: null, tier: 'anonymous' };
            return { res: problem(401, 'token.missing', `${d.id} needs a signed-in person or a token${d.auth.anonymous ? ' (the mock has no browser sessions for job owners)' : ''}`) };
        }
        if (!auth.startsWith('Bearer ')) return { res: problem(401, 'token.missing', 'no Bearer token') };
        const claims = ctx.decode(auth.slice(7));
        if (!claims) return { res: problem(401, 'token.bad_signature', 'not a valid token') };
        if (claims.actor_type) {
            const who = ctx.principal(req, 'openvibe.tools', d.auth.capability);
            return who.res ? who : { owner: claims.sub, env: claims.env === 'sandbox' ? 'sandbox' : 'production', tier: claims.actor_type };
        }
        if (d.auth.capability === 'tools.net.probe') return { res: problem(403, 'capability.denied', 'Network probes run through the API only for principals holding tools.net.probe; people use the tool page') };
        return { owner: `user:${claims.subject_id}`, env: 'production', tier: 'user' };
    }

    /** tools.run-request@1 from JSON or multipart -> { body, uploads } or { res }. */
    async function readRun(req) {
        const ct = req.headers.get('content-type') || '';
        const invalid = (detail) => ({ res: problem(400, 'tools.run.invalid', detail) });
        if (ct.startsWith('multipart/form-data')) {
            let form;
            try { form = await req.formData(); } catch { return invalid('not a multipart body'); }
            const body = {};
            const uploads = [];
            for (const [name, value] of form.entries()) {
                if (typeof value !== 'string') {
                    if (name !== 'file' && name !== 'files') return invalid(`a file part is named file or files, not ${name}`);
                    uploads.push({ name: value.name || 'file', type: value.type || '', bytes: Buffer.from(await value.arrayBuffer()) });
                    continue;
                }
                if (!RUN_FIELDS.has(name)) return invalid(`unknown field ${name}`);
                if (name === 'input' || name === 'files') {
                    try { body[name] = JSON.parse(value || (name === 'input' ? '{}' : '[]')); } catch { return invalid(`${name} must be JSON`); }
                } else if (name === 'wait_ms') body.wait_ms = Number(value);
                else body[name] = value;
            }
            return { body, uploads };
        }
        let body;
        try { body = await req.json(); } catch { return invalid('send JSON (tools.run-request@1) or multipart'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('the body is a JSON object');
        for (const k of Object.keys(body)) if (!RUN_FIELDS.has(k)) return invalid(`unknown field ${k}`);
        return { body, uploads: [] };
    }

    /** The files a reference names, read for this caller -> { file } or { res }. */
    function resolveRef(ref, who) {
        const notFound = (what) => ({ res: problem(404, 'tools.run.file_not_found', `${what} is not a file you can read`) });
        if (ref && typeof ref.media_id === 'string' && MEDIA_ID_RE.test(ref.media_id) && Object.keys(ref).length === 1) {
            const o = media.get(ref.media_id);
            if (!o) return notFound(ref.media_id);
            return { file: { name: o.name || 'file', type: o.type || o.mime || 'application/octet-stream', bytes: Buffer.from(o.data || o.bytes || '') } };
        }
        if (ref && typeof ref.job_id === 'string' && JOB_ID_RE.test(ref.job_id) && Number.isInteger(ref.index) && ref.index >= 0 && ref.index <= 99 && Object.keys(ref).length === 2) {
            const job = ctx.jobs.jobs.get(ref.job_id);
            const f = job && job.owner === who.owner && job.state === 'succeeded' ? job.result.files[ref.index] : null;
            if (!f) return notFound(`${ref.job_id} file ${ref.index}`);
            return { file: { name: f.name, type: f.mime, bytes: f.bytes } };
        }
        return { res: problem(400, 'tools.run.invalid', 'a files reference is { media_id } or { job_id, index }') };
    }

    const tookMs = (job) => Math.max(0, (job.finishedAt || Date.now()) - job.createdAt);
    /** A job run as tools.run@1. */
    function runView(d, job) {
        const view = ctx.jobs.view(job);
        if (job.state === 'succeeded') return { state: 'succeeded', tool: d.id, result: { data: view.result.data, files: view.result.files }, took_ms: tookMs(job), job: view };
        if (job.state === 'failed' || job.state === 'cancelled') return { state: job.state, tool: d.id, error: view.error, took_ms: tookMs(job), job: view };
        return { state: job.state, tool: d.id, job: view, location: view.links.self };
    }

    async function waitFor(job, ms, signal) {
        const end = Date.now() + ms;
        while (!TERMINAL_JOB_STATES.has(job.state) && Date.now() < end && !(signal && signal.aborted)) {
            await new Promise((r) => setTimeout(r, Math.min(stepMs, Math.max(1, end - Date.now()))));
        }
    }

    async function run(req, url, d) {
        if (d.status === 'unavailable') return problem(503, 'tools.tool.unavailable', d.statusReason || `${d.id} is unavailable`);
        if (!d.api || !d.run) return problem(404, 'tools.tool.not_runnable', `${d.id} has no run API; use its page`);
        const who = caller(req, d);
        if (who.res) return who.res;
        const got = await readRun(req);
        if (got.res) return got.res;
        const { body, uploads } = got;
        const input = body.input === undefined ? {} : body.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return problem(400, 'tools.run.invalid', 'input is a JSON object');
        const wait = body.wait_ms === undefined ? Number(url.searchParams.get('wait_ms') || 0) : body.wait_ms;
        if (!Number.isInteger(wait) || wait < 0 || wait > 60000) return problem(400, 'tools.run.invalid', 'wait_ms is an integer, 0..60000');
        if (body.files !== undefined && (!Array.isArray(body.files) || body.files.length > 50)) return problem(400, 'tools.run.invalid', 'files is an array of at most 50 references');
        const refs = body.files || [];
        const files = [...uploads];
        for (const ref of refs) {
            const r = resolveRef(ref, who);
            if (r.res) return r.res;
            files.push(r.file);
        }
        const spec = d.files;
        if (!spec && files.length) return problem(400, 'tools.run.invalid', `${d.id} takes no files`);
        if (spec && (files.length < spec.min || files.length > spec.max)) return problem(400, 'tools.run.invalid', `${d.id} takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} file(s), got ${files.length}`);
        if (spec) {
            for (const f of files) {
                if (f.bytes.length > spec.maxBytes) return problem(413, 'tools.file.too_large', `${f.name} is over ${spec.maxBytes} bytes`);
                if (!accepts(spec.accept, f.type)) return problem(415, 'tools.file.unsupported_type', `${f.name} (${f.type}) is not ${spec.accept.join(', ')}`);
            }
        }
        const errors = checkInput(d.input, input);
        if (errors.length) return problem(422, 'tools.input.invalid', `The input does not match ${d.id}'s input schema`, { errors });

        if (d.execution !== 'job') {
            const started = Date.now();
            const handler = handlers[d.id];
            if (!handler) return problem(503, 'tools.tool.unavailable', `the mock has no handler for ${d.id} (tools.handlers)`);
            try {
                const out = await handler({ input, files, caller: { owner: who.owner, tier: who.tier }, signal: req.signal });
                const result = typeof out === 'string' ? { text: out } : out && (out.data !== undefined || out.text !== undefined) ? { ...(out.data !== undefined ? { data: out.data } : {}), ...(out.text !== undefined ? { text: String(out.text) } : {}) } : { data: out || {} };
                return json(200, { state: 'succeeded', tool: d.id, result, took_ms: Date.now() - started }, { 'Cache-Control': 'no-store' });
            } catch (err) {
                const code = /^tools\.[a-z0-9_.]+$/.test(String((err && err.code) || '')) ? err.code : 'tools.job.failed';
                const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 422;
                return json(200, { state: 'failed', tool: d.id, error: problemBody(status, code, (err && err.message) || 'The tool failed'), took_ms: Date.now() - started }, { 'Cache-Control': 'no-store' });
            }
        }

        // A job tool: one job per (caller, Idempotency-Key) and request.
        const key = req.headers.get('idempotency-key') || (typeof body.idempotency_key === 'string' ? body.idempotency_key : null);
        const hash = sha256hex(JSON.stringify([d.id, input, refs, uploads.map((f) => sha256hex(f.bytes))]));
        let job;
        let replayed = false;
        const prior = key ? runKeys.get(`${who.owner}|${key}`) : null;
        if (prior) {
            if (prior.hash !== hash) return problem(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request');
            job = ctx.jobs.jobs.get(prior.jobId);
            replayed = true;
        } else {
            const jobInput = { ...input, ...(d.run.job.preset || {}), tool: d.run.job.operation };
            const handler = handlers[d.id] || null;
            const out = ctx.jobs.create({ origin: gateway, owner: who.owner, env: who.env, type: d.run.job.type, input: jobInput, files, handler: handler || (async ({ files: fs }) => ({ data: {}, files: fs.map((f) => ({ name: f.name, mime: f.type, bytes: f.bytes })) })), tool: d.id });
            if (out.res) return out.res;
            job = out.job;
            if (key) runKeys.set(`${who.owner}|${key}`, { jobId: job.id, hash });
        }
        if (wait > 0) await waitFor(job, wait, req.signal);
        const view = runView(d, job);
        const headers = { 'Cache-Control': 'no-store', ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}) };
        if (view.location) headers.Location = view.location;
        return json(replayed || !view.location ? 200 : 202, view, headers);
    }

    async function handle(req, url) {
        if (!ctx.opts.tools) return problem(404, 'not_found', 'the tools API is not enabled on this mock (createMockPlatform({ tools: true }))');
        if (url.origin !== gateway) return problem(404, 'not_found', 'the tools API is on the gateway (origins.tools)');
        const path = url.pathname;
        let m;
        if (path === '/api/v1/tools' && req.method === 'GET') return list(url);
        if ((m = path.match(/^\/api\/v1\/tools\/([^/]+)(\/schema|\/run)?$/))) {
            const d = tools.get(decodeURIComponent(m[1]));
            if (!d) return problem(404, 'tools.tool.not_found', `No tool ${decodeURIComponent(m[1])}`);
            if (m[2] === '/run') return req.method === 'POST' ? run(req, url, d) : problem(405, 'method_not_allowed', 'POST a tools.run-request@1');
            if (req.method !== 'GET') return problem(405, 'method_not_allowed', 'method not allowed');
            if (m[2] === '/schema') {
                return json(200, { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: schemaUrl(d.id), $defs: { input: d.input ? clone(d.input) : null, output: d.output.schema ? clone(d.output.schema) : null } });
            }
            return json(200, clone(d), { 'Cache-Control': 'public, max-age=60' });
        }
        return problem(404, 'not_found', 'Not found');
    }

    return {
        handle,
        tools,
        addTool,
        /** Store a Media object that { media_id } references read; returns its id. */
        addMediaObject({ id, name = 'file', type = 'application/octet-stream', data = '' } = {}) {
            const mid = id || `med_${ulid()}`;
            media.set(mid, { name, type, data });
            return mid;
        },
    };
}

module.exports = { createToolsService, defaultDescriptors };
