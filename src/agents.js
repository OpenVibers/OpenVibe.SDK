'use strict';
/**
 * openvibe-sdk/agents — the client for the agent engine (OpenVibe.Contracts docs/agents-runs.md).
 *
 * Everything a person asks an AI to do on OpenVibe is a run, and a run is a thread of steps: a chat with Vibe, a
 * question in a composer, a task for an agent, a coding task, a job on a machine. One shape (`agents.run@1`,
 * `agents.step@1`, `agents.approval@1`), one set of routes (the Run API), on every product that hosts runs and, for
 * every product at once, on the Frame.
 *
 *   const agents = createAgentsClient(client);                       // one product (Network by default)
 *   const all = createFrameAgentsClient(client);                     // every product, through the Frame
 *
 *   const { runs, next } = await all.runs.list({ kind: 'chat', limit: 20 });
 *   const run = await all.runs.start('A goal bar for my sub goal');  // or the whole agents.run-start@1 object
 *   await all.runs.say(run, 'Make it purple');                       // continue or steer it
 *   const { steps } = await all.runs.steps(run, { after: 10 });
 *   await all.runs.follow(run, { onStep, onDelta, onRun });          // the live stream, until it ends
 *   await all.approvals.answer(run, 'apr_…', 'approve');
 *   await all.runs.stop(run, { reason: 'not now' });
 *
 * The Run API, relative to the client's prefix (`/api/v1` on a product, `/api/frame` on the Frame, where a run's id
 * is its ref, `<product>:<id>`):
 *   GET  /runs?kind=&status=&q=&limit=&cursor=      POST /runs                      (agents.run-start@1)
 *   GET  /runs/:id                                   GET  /runs/:id/steps?after=&limit=
 *   GET  /runs/:id/events                            POST /runs/:id/messages         { text, attachments }
 *   POST /runs/:id/stop  { reason }                  POST /runs/:id/approvals/:id    { answer }
 *   GET  /runs/:id/desks · POST …/desks/:desk/take-over · …/hand-back · GET /runs/:id/replay
 *
 * A product other than Network: { service: 'actor', audience: 'openvibe.actor' } (or { baseUrl }).
 * The plugin interfaces of the engine's loop (model adapter, tool, sandbox, memory, planner, reviewer) are described
 * at the end of this file; `openvibe-sdk/agents/loop` is where they are called.
 */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { parseSSE } = require('./realtime');

const enc = encodeURIComponent;
const pause = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** The kinds a run may be; a product may add its own, and a reader treats an unknown kind as `task`. */
const KINDS = Object.freeze(['chat', 'ask', 'task', 'code', 'machine', 'goal']);
/** A run's statuses; the last three are ends, and an end never changes. */
const STATUSES = Object.freeze(['planning', 'running', 'waiting', 'done', 'failed', 'stopped']);
const END_STATUSES = Object.freeze(['done', 'failed', 'stopped']);
const REF = /^([a-z][a-z0-9-]{0,30}):([A-Za-z0-9._~-]{1,160})$/;

/** Has this run (or status) ended? */
function isEnd(runOrStatus) {
    const s = typeof runOrStatus === 'string' ? runOrStatus : runOrStatus && runOrStatus.status;
    return END_STATUSES.includes(s);
}
/** A run's address on the Frame: `<product>:<id>`. */
function refOf(product, id) {
    const ref = `${String(product || '')}:${String(id || '')}`;
    if (!REF.test(ref)) throw new TypeError('agents.refOf: a product (a-z, 0-9, -) and an id are required');
    return ref;
}
/** `{ product, id }` from a ref, or null when it is not one. */
function parseRef(ref) {
    const m = REF.exec(String(ref || ''));
    return m ? { product: m[1], id: m[2] } : null;
}
/** Does this run need its person now (an approval, a takeover, a payment), as opposed to a conversation between turns? */
function needsPerson(run) {
    return !!run && run.status === 'waiting' && !!run.waiting && run.waiting.for !== 'message';
}

const runIdOf = (run) => {
    if (typeof run === 'string' && run) return run;
    if (run && typeof run === 'object') return typeof run.ref === 'string' && run.ref ? run.ref : (typeof run.id === 'string' ? run.id : null);
    return null;
};

function createAgentsClient(client, { baseUrl, service = 'network', audience = 'openvibe.network', prefix = '/api/v1' } = {}) {
    if (typeof prefix !== 'string' || !/^\/[a-z0-9/_-]+$/i.test(prefix)) throw new TypeError('agents: prefix is a path such as /api/v1');
    // On the Frame a run is named by its ref; on a product by its own id.
    const byRef = prefix === '/api/frame';
    const call = (opts) => client.request({ service, baseUrl, audience, ...opts });
    const at = (what, run) => {
        const id = byRef ? runIdOf(run) : (typeof run === 'string' ? run : run && run.id);
        if (!id) throw new TypeError(`${what}: a run (or its id) is required`);
        return `${prefix}/runs/${enc(id)}`;
    };
    const deskId = (desk) => {
        if (typeof desk !== 'string' || !desk) throw new TypeError('agents: a desk id is required');
        return enc(desk);
    };

    // ── runs ──
    async function list({ kind, status, q, limit, cursor, before, agent, parentRun, signal } = {}) {
        return (await call({ path: `${prefix}/runs`, query: { kind, status, q, limit, cursor, before, agent, parent_run: parentRun }, signal })).data;
    }
    async function get(run, { signal } = {}) {
        try { return (await call({ path: at('agents.runs.get', run), headers: { Accept: 'application/vnd.openvibe.agents.run+json, application/json' }, signal })).data; }
        catch (err) { if (isOpenVibeError(err) && err.status === 404) return null; throw err; }
    }
    async function steps(run, { after, limit, signal } = {}) {
        if (after != null && !Number.isInteger(Number(after))) throw new TypeError('agents.runs.steps: after is a step seq');
        return (await call({ path: `${at('agents.runs.steps', run)}/steps`, query: { after, limit }, signal })).data;
    }
    /** Start a run. `request` is the words, or the whole agents.run-start@1 object; only `text` is required. */
    async function start(request, { signal, idempotencyKey } = {}) {
        const body = typeof request === 'string' ? { text: request } : request;
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string' || !body.text.trim()) {
            throw new TypeError('agents.runs.start: the words to start with are required ({ text })');
        }
        return (await call({ method: 'POST', path: `${prefix}/runs`, json: body, ...(idempotencyKey ? { idempotencyKey } : {}), signal })).data;
    }
    /** Say something to a run: continue a conversation, answer a question in words, or steer work under way. */
    async function say(run, message, { signal, idempotencyKey } = {}) {
        const body = typeof message === 'string' ? { text: message } : message;
        if (!body || typeof body !== 'object' || Array.isArray(body) || ((typeof body.text !== 'string' || !body.text.trim()) && !(Array.isArray(body.attachments) && body.attachments.length))) {
            throw new TypeError('agents.runs.say: words or attachments are required');
        }
        return (await call({ method: 'POST', path: `${at('agents.runs.say', run)}/messages`, json: body, ...(idempotencyKey ? { idempotencyKey } : {}), signal })).data;
    }
    async function stop(run, { reason, signal } = {}) {
        return (await call({ method: 'POST', path: `${at('agents.runs.stop', run)}/stop`, ...(reason !== undefined ? { json: { reason } } : {}), signal })).data;
    }
    /**
     * A run's stream, as an async iterator of `{ id, event, data }`. It reconnects with Last-Event-ID (a step's seq on
     * the engine's stream) and ends at the stream's `end` event (or AG-UI's RUN_FINISHED / RUN_ERROR on an Ask run).
     */
    async function* events(run, { after, lastEventId = 0, signal, maxReconnects = 20, reconnectDelayMs = 1000 } = {}) {
        const path = `${at('agents.events', run)}/events`;
        let last = String(after != null ? after : (lastEventId || '0')), failures = 0, serverRetryMs = 0;
        while (!(signal && signal.aborted)) {
            let delivered = false;
            try {
                const res = await call({ path, responseType: 'response', retries: 0, signal,
                    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': last } });
                if (res.status === 204) return;
                for await (const msg of parseSSE(res.data.body, { onRetry: (ms) => { serverRetryMs = ms; } })) {
                    // Only a step advances the cursor and is skipped when already seen: a run snapshot, more text for a
                    // step, an approval and the end carry the newest step's seq as their id.
                    const soft = msg.event === 'run' || msg.event === 'delta' || msg.event === 'approval' || msg.event === 'end';
                    if (msg.id !== undefined && msg.id !== '') {
                        const numeric = /^\d+$/.test(msg.id);
                        if (!soft && numeric && Number(msg.id) <= Number(last)) continue;
                        if (!numeric || Number(msg.id) > Number(last)) last = msg.id;
                    }
                    let data; try { data = JSON.parse(msg.data); } catch { data = null; }
                    delivered = true; failures = 0;
                    const event = msg.event || (data && data.type) || null;
                    yield { id: msg.id ?? null, event, data };
                    if (event === 'end' || (data && ['RUN_FINISHED', 'RUN_ERROR'].includes(data.type))) return;
                }
            } catch (err) {
                if (signal && signal.aborted) return;
                if (isOpenVibeError(err) && err.status >= 400 && err.status < 500) throw err;
                if (!isOpenVibeError(err) && !['TypeError', 'AbortError'].includes(err && err.name)) throw err;
            }
            failures = delivered ? 0 : failures + 1;
            if (failures > maxReconnects) throw new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: `agents: the stream of ${runIdOf(run)} failed ${failures} times in a row` });
            const backoffMs = Math.min(reconnectDelayMs * (2 ** Math.max(0, failures - 1)), 30000);
            await pause(Math.min(Math.max(backoffMs, serverRetryMs), 30000), signal);
        }
    }
    /**
     * Follow a run until it ends: `onRun(run)` for a new snapshot, `onStep(step)` for an appended step,
     * `onDelta({ seq, text })` for more words of a step being written, `onApproval(approval)`, `onEvent(event)` for
     * everything. Resolves with `{ status }` (the end status, or null when the stream closed without one).
     */
    async function follow(run, { onRun, onStep, onDelta, onApproval, onEvent, ...options } = {}) {
        for await (const e of events(run, options)) {
            if (onEvent) await onEvent(e);
            const d = e.data || {};
            if (e.event === 'run' && d.run && onRun) await onRun(d.run);
            else if (e.event === 'step' && d.step && onStep) await onStep(d.step);
            else if (e.event === 'delta' && onDelta) await onDelta({ run_id: d.run_id, seq: d.seq, text: d.text });
            else if (e.event === 'approval' && d.approval && onApproval) await onApproval(d.approval);
            else if (e.event === 'end') return { status: d.status || null };
            else if (d.type === 'RUN_FINISHED') return { status: 'done' };
            else if (d.type === 'RUN_ERROR') return { status: 'failed' };
        }
        return { status: null };
    }

    // ── approvals ──
    /** Answer an approval: by its id (agents.approval@1's `id`), or by the seq of the step that asked. */
    async function answer(run, approval, reply, { signal } = {}) {
        const id = typeof approval === 'number' ? String(approval) : (approval && typeof approval === 'object' ? (approval.id || String(approval.step_seq || '')) : String(approval || ''));
        if (!id || !/^[A-Za-z0-9._~-]{1,160}$/.test(id)) throw new TypeError('agents.approvals.answer: an approval (its id or its step seq) is required');
        if (reply === undefined || reply === null || reply === '') throw new TypeError('agents.approvals.answer: an answer is required');
        return (await call({ method: 'POST', path: `${at('agents.approvals.answer', run)}/approvals/${enc(id)}`, json: { answer: reply }, signal })).data;
    }

    // ── see it work (0.157.0): the desks a run may show, the person's control of one, the finished run's replay ──
    async function desks(run, { signal } = {}) {
        return (await call({ path: `${at('agents.desks', run)}/desks`, signal })).data;
    }
    async function takeOver(run, desk, { signal } = {}) {
        return (await call({ method: 'POST', path: `${at('agents.takeOver', run)}/desks/${deskId(desk)}/take-over`, signal })).data;
    }
    async function handBack(run, desk, note = '', { signal } = {}) {
        if (note != null && typeof note !== 'string') throw new TypeError('agents.handBack: note is a string');
        return (await call({ method: 'POST', path: `${at('agents.handBack', run)}/desks/${deskId(desk)}/hand-back`, json: { note: String(note || '').slice(0, 1000) }, signal })).data;
    }
    async function replay(run, { signal } = {}) {
        return (await call({ path: `${at('agents.replay', run)}/replay`, signal })).data;
    }

    // ── the first shapes (an Ask run's snapshot and approval post on Network), kept as they were released ──
    async function run(id, { signal } = {}) {
        if (!id) throw new TypeError('agents.run: id is required');
        try { return (await call({ path: `${prefix}/runs/${enc(id)}`, signal })).data; }
        catch (err) { if (isOpenVibeError(err) && err.status === 404) return null; throw err; }
    }
    async function post(id, approval, { signal } = {}) {
        if (!id) throw new TypeError('agents.post: id is required');
        if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new TypeError('agents.post: approval must be an object');
        return (await call({ method: 'POST', path: `${prefix}/runs/${enc(id)}/approvals`, json: approval, signal })).data;
    }

    return {
        runs: { list, get, steps, start, say, stop, events, follow },
        approvals: { answer },
        desks, takeOver, handBack, replay,
        run, post, events,
    };
}

/** Every product's runs through the Frame (`/api/frame/runs…` on Network): a run is named by its ref. */
function createFrameAgentsClient(client, options = {}) {
    return createAgentsClient(client, { ...options, service: 'network', audience: 'openvibe.network', prefix: '/api/frame' });
}

/**
 * A model adapter is the only way the loop reaches a model: Exchange's routes, a person's own key, a machine's local
 * model or a signed-in plan. It returns the model's next turn and what it cost.
 * @typedef {object} AgentModelAdapter
 * @property {string} id             A stable id for the model (the picker's row id, e.g. "openvibe:deepseek-v4").
 * @property {string} [family]       The model family, for a reviewer of another family.
 * @property {(request: { messages: object[], tools?: AgentTool[], model?: string, budget?: object, signal?: AbortSignal }) => Promise<{ text?: string, tool_calls?: object[], usage?: { tokens?: number }, cost?: { usd?: number }, raw?: object }>} complete
 */

/**
 * A tool the loop may call. OpenVibe products are tools (Search, Media, Live, Bot, a machine through Link); an MCP
 * server is a bag of them. The registry decides which a run may use; a tool never sees a credential it does not need.
 * @typedef {object} AgentTool
 * @property {string} name
 * @property {string} description
 * @property {object} [inputSchema]  JSON Schema for `input`.
 * @property {(input: object, context: { run: object, toolCall: object, signal?: AbortSignal }) => Promise<{ result: any, cost?: { usd?: number }, artifacts?: object[] }>} run
 */

/**
 * A sandbox is where code runs: a Codes runner, a machine through Link or an OpenVibe computer. The loop asks; the
 * sandbox owns isolation, egress and the redaction of what it returns.
 * @typedef {object} AgentSandbox
 * @property {string} id
 * @property {string} [where]        agents.run@1's `where.kind`: "openvibe" | "machine" | "runner" | "this-computer"
 * @property {(command: string | string[], options?: { cwd?: string, env?: object, timeoutMs?: number, signal?: AbortSignal }) => Promise<{ ok: boolean, output: string, exitCode?: number, artifacts?: object[] }>} exec
 * @property {(path: string, options?: { encoding?: string }) => Promise<string | Uint8Array>} [readFile]
 * @property {(path: string, data: string | Uint8Array) => Promise<{ path: string, bytes?: number }>} [writeFile]
 */

/**
 * Memory is what a run may remember between steps and runs. It is scoped to the owner; a run never reads another
 * owner's memory, and what it remembers says where it came from.
 * @typedef {object} AgentMemory
 * @property {(query: { text?: string, kinds?: string[], limit?: number }) => Promise<object[]>} read
 * @property {(entry: { text: string, kind?: string, ref?: string, data?: object }) => Promise<object>} write
 * @property {(id: string) => Promise<boolean>} [forget]
 */

/**
 * The planner turns the person's words into a plan before the loop runs; a strong model plans once and small ones
 * execute (the Dispatcher's "plan big, execute small").
 * @typedef {object} AgentPlanner
 * @property {(input: { run: object, text: string, context?: object, signal?: AbortSignal }) => Promise<{ steps: Array<{ title: string, kind?: string, tool?: string }>, text?: string }>} plan
 */

/**
 * The reviewer checks a run: a model of another family, a test suite, a written bar. A run is never delivered as
 * checked unless the reviewer passed it.
 * @typedef {object} AgentReviewer
 * @property {(input: { run: object, result: any, steps?: object[], signal?: AbortSignal }) => Promise<{ ok: boolean, reason?: string, by?: string, cross?: boolean }>} review
 */

module.exports = { createAgentsClient, createFrameAgentsClient, KINDS, STATUSES, END_STATUSES, isEnd, refOf, parseRef, needsPerson };
