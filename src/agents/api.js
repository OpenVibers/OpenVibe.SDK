'use strict';
/**
 * openvibe-sdk/agents/api — the Run API from a store (agent-engine.md §9; Contracts docs/agents-runs.md). A product
 * writes its store once (its own tables, its own runs) and serves the same routes as every other product and the Frame:
 *
 *   GET  /runs?kind=&status=&q=&limit=&cursor=    { runs, next }
 *   POST /runs                                     agents.run-start@1 → 201 the run (Idempotency-Key: the first run again)
 *   GET  /runs/:id                                 the run
 *   GET  /runs/:id/steps?after=&limit=             { steps, next }
 *   GET  /runs/:id/events                          agents.event@1 as server-sent events (Last-Event-ID: a step's seq)
 *   POST /runs/:id/messages                        { text, attachments } → 201 the step
 *   POST /runs/:id/stop                            { reason } → the run
 *   POST /runs/:id/approvals/:approval             { answer } → what the store answers
 *
 *   const api = createRunApi({ product: 'chat', subject: async (req) => personOf(req), store });
 *   app.use('/api/v1', (req, res, next) => api.handle(req, res, next));   // Express, or any Node http server
 *
 * The store (every method gets `owner`, the caller as { type, id }; a method it does not have answers 409):
 *   list({ owner, kind, status, q, limit, cursor })  → { runs, next }
 *   get({ owner, id })                               → run | null
 *   steps({ owner, id, after, limit })               → { steps, next }
 *   start({ owner, input, idempotencyKey })          → run
 *   say({ owner, id, text, attachments })            → step
 *   stop({ owner, id, reason })                      → run
 *   answer({ owner, id, approval, answer })          → anything
 *   follow({ owner, id, after, signal, emit })       → optional: push events (emit(event, data, id)) until the signal
 *                                                      aborts; without it the stream reads new steps every pollMs
 *
 * What it keeps: a caller without a subject gets 401; a run id or an approval id that is not one gets 404; a start
 * without words, or with a kind or a body that is not one, gets 422; every run it returns carries its ref
 * (`<product>:<id>`); the stream closes after streamMs so no proxy holds it forever, and the client resumes after the
 * last step it has. Errors a store throws with { status, code, message } go out as they are; anything else is a 500
 * that says nothing of the store.
 */

const KINDS = ['chat', 'ask', 'task', 'code', 'machine', 'goal'];
const STATUSES = ['planning', 'running', 'waiting', 'done', 'failed', 'stopped'];
const ID = /^[A-Za-z0-9._~:-]{1,200}$/;
const APPROVAL = /^[A-Za-z0-9._~-]{1,160}$/;
const KEY = /^[A-Za-z0-9._~-]{1,200}$/;
const BODY_MAX = 64 * 1024;

function problem(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function readJson(req) {
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw problem(400, 'runs.bad_json', 'The body is not JSON'); } }
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > BODY_MAX) throw problem(413, 'runs.too_large', 'The body is larger than 64 KB'); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { throw problem(400, 'runs.bad_json', 'The body is not JSON'); }
}

function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
}

/** A start body as agents.run-start@1 says it, or a 422 naming what is wrong. */
function startInput(b) {
    const text = clip(b && b.text, 16000).trim();
    if (!text) throw problem(422, 'runs.start_needs_words', 'Say what the run is for ({ text })');
    if (b.kind != null && !KINDS.includes(b.kind)) throw problem(422, 'runs.bad_kind', `kind is one of ${KINDS.join(', ')}`);
    const out = { ...b, text };
    if (b.attachments != null && !Array.isArray(b.attachments)) throw problem(422, 'runs.bad_attachments', 'attachments is a list');
    if (Array.isArray(b.attachments)) out.attachments = b.attachments.slice(0, 20);
    // A mandate comes from intake only (agents.run-start@1 1.1.0): a product's own caller never sets one.
    delete out.mandate;
    return out;
}

function createRunApi({ store, subject, product, prefix = '', pollMs = 1500, streamMs = 55000, intake = null } = {}) {
    if (!store || typeof store !== 'object') throw new TypeError('agents/api: a store is required');
    if (typeof subject !== 'function') throw new TypeError('agents/api: subject(req) is required (who is calling)');
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(String(product || ''))) throw new TypeError('agents/api: product is a short lowercase name (chat, actor, codes…)');
    const base = String(prefix || '').replace(/\/+$/, '');
    const withRef = (run) => (run && typeof run === 'object' && run.id != null && !run.ref ? { ...run, ref: `${product}:${run.id}` } : run);
    const need = (name) => { if (typeof store[name] !== 'function') throw problem(409, `runs.cannot_${name}`, `A ${product} run cannot ${name === 'say' ? 'take messages' : name === 'answer' ? 'be answered' : name} here yet`); };

    async function who(req) {
        let s = null;
        try { s = await subject(req); } catch { s = null; }
        if (!s || !s.id) throw problem(401, 'auth.required', 'Sign in to see your runs');
        return { type: s.type || 'user', id: String(s.id) };
    }

    async function list(req, res, owner, url) {
        const q = url.searchParams;
        const kind = KINDS.includes(q.get('kind')) ? q.get('kind') : null;
        const status = STATUSES.includes(q.get('status')) ? q.get('status') : null;
        const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 30, 1), 100);
        need('list');
        const out = await store.list({ owner, kind, status, q: clip(q.get('q'), 200) || null, limit, cursor: clip(q.get('cursor'), 400) || null });
        send(res, 200, { runs: (out && Array.isArray(out.runs) ? out.runs : []).slice(0, limit).map(withRef), next: (out && out.next) || null });
    }

    async function events(req, res, owner, id, url) {
        const last = String(req.headers['last-event-id'] || url.searchParams.get('after') || '0');
        if (!/^\d{1,16}$/.test(last)) return send(res, 400, { error: 'Last-Event-ID is a step seq', code: 'runs.bad_event_id' });
        need('get');
        const run = await store.get({ owner, id });
        if (!run) throw problem(404, 'runs.not_found', 'No such run');
        let after = Number(last);
        const ctl = new AbortController();
        req.on('close', () => ctl.abort());
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const emit = (event, data, eventId) => { if (!ctl.signal.aborted) res.write(`${eventId != null ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
        const timer = setTimeout(() => ctl.abort(), streamMs);
        try {
            if (typeof store.follow === 'function') {
                await store.follow({ owner, id, after, signal: ctl.signal, emit: (event, data, eventId) => emit(event, event === 'run' && data && data.run ? { ...data, run: withRef(data.run) } : data, eventId) });
            } else {
                need('steps');
                while (!ctl.signal.aborted) {
                    const page = await store.steps({ owner, id, after, limit: 100 });
                    const fresh = (page && Array.isArray(page.steps) ? page.steps : []).filter((s) => s && Number(s.seq) > after);
                    fresh.forEach((s) => { emit('step', { step: s }, s.seq); after = Math.max(after, Number(s.seq)); });
                    if (fresh.length) {
                        const now = await store.get({ owner, id });
                        if (now) {
                            emit('run', { run: withRef(now) }, after);
                            if (['done', 'failed', 'stopped'].includes(now.status)) { emit('end', { run_id: withRef(now).ref, status: now.status }, after); break; }
                        }
                    }
                    await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); ctl.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
                }
            }
        } catch (err) {
            emit('error', { error: err && err.status ? err.message : 'The run could not be read', code: (err && err.code) || 'runs.error' });
        } finally {
            clearTimeout(timer);
            if (!res.writableEnded) res.end();
        }
    }

    /** Answer one request; `next()` (when given) for a path that is not the Run API's. */
    async function handle(req, res, next) {
        let url;
        try { url = new URL(req.originalUrl || req.url, 'http://local'); } catch { return next ? next() : send(res, 404, { error: 'Not found', code: 'runs.not_found' }); }
        let path = url.pathname;
        if (base) { if (!path.startsWith(base)) return next ? next() : send(res, 404, { error: 'Not found', code: 'runs.not_found' }); path = path.slice(base.length) || '/'; }
        const m = /^\/runs(?:\/([^/]+)(?:\/(steps|events|messages|stop|approvals)(?:\/([^/]+))?)?)?\/?$/.exec(path);
        if (!m) return next ? next() : send(res, 404, { error: 'Not found', code: 'runs.not_found' });
        const [, rawId, part, rawApproval] = m;
        const method = String(req.method || 'GET').toUpperCase();
        try {
            const owner = await who(req);
            const id = rawId === undefined ? null : decodeURIComponent(rawId);
            if (id !== null && !ID.test(id)) throw problem(404, 'runs.not_found', 'No such run');
            const localId = id && id.startsWith(`${product}:`) ? id.slice(product.length + 1) : id;
            if (!id) {
                if (method === 'GET') return await list(req, res, owner, url);
                if (method === 'POST') {
                    need('start');
                    const input = startInput(await readJson(req));
                    if (intake && typeof intake === 'function') { const mandate = await intake(req, input); if (mandate) input.mandate = mandate; }
                    const key = String(req.headers['idempotency-key'] || '');
                    if (key && !KEY.test(key)) throw problem(422, 'runs.bad_key', 'Idempotency-Key is 1 to 200 letters, digits or ._~-');
                    const run = await store.start({ owner, input, idempotencyKey: key || null });
                    return send(res, 201, withRef(run));
                }
                throw problem(405, 'runs.method', 'GET or POST');
            }
            if (!part) {
                if (method !== 'GET') throw problem(405, 'runs.method', 'GET');
                need('get');
                const run = await store.get({ owner, id: localId });
                if (!run) throw problem(404, 'runs.not_found', 'No such run');
                return send(res, 200, withRef(run));
            }
            if (part === 'steps') {
                if (method !== 'GET') throw problem(405, 'runs.method', 'GET');
                need('steps');
                const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
                const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
                const out = await store.steps({ owner, id: localId, after, limit });
                if (!out) throw problem(404, 'runs.not_found', 'No such run');
                return send(res, 200, { steps: (Array.isArray(out.steps) ? out.steps : []).slice(0, limit), next: out.next || null });
            }
            if (part === 'events') { if (method !== 'GET') throw problem(405, 'runs.method', 'GET'); return await events(req, res, owner, localId, url); }
            if (method !== 'POST') throw problem(405, 'runs.method', 'POST');
            const b = await readJson(req);
            if (part === 'messages') {
                need('say');
                const text = clip(b.text, 16000);
                const attachments = Array.isArray(b.attachments) ? b.attachments.slice(0, 20) : [];
                if (!text.trim() && !attachments.length) throw problem(422, 'runs.say_needs_words', 'Say something ({ text })');
                return send(res, 201, await store.say({ owner, id: localId, text, attachments }));
            }
            if (part === 'stop') { need('stop'); return send(res, 200, withRef(await store.stop({ owner, id: localId, reason: clip(b.reason, 500) || null }))); }
            if (part === 'approvals') {
                const approval = rawApproval ? decodeURIComponent(rawApproval) : '';
                if (!APPROVAL.test(approval)) throw problem(404, 'runs.not_found', 'No such approval');
                if (b.answer === undefined || b.answer === null || b.answer === '') throw problem(422, 'runs.answer_needed', 'An answer is required ({ answer })');
                need('answer');
                return send(res, 200, await store.answer({ owner, id: localId, approval, answer: b.answer }));
            }
            throw problem(404, 'runs.not_found', 'Not found');
        } catch (err) {
            const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            return send(res, status, { error: status === 500 && !(err && err.status) ? 'Runs are unavailable right now' : String((err && err.message) || 'Error'), code: (err && err.code) || 'runs.error' });
        }
    }

    return { handle, KINDS, STATUSES };
}

module.exports = { createRunApi, startInput, KINDS, STATUSES };
