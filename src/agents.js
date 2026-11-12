'use strict';
/**
 * openvibe-sdk/agents — one client for the one agent system: a run's snapshot and steps, starting and stopping a
 * run, answering an approval, and the AG-UI/SSE stream that follows a run live. The shapes are Contracts'
 * `agents.run@1`, `agents.step@1` and `agents.approval@1`; the same calls work against Actor (which serves its
 * runs read-only today), Codes and Run once they serve the shape.
 *
 *   const agents = createAgentsClient(client);
 *   const { runs, next } = await agents.runs.list({ limit: 20 });
 *   const run = await agents.runs.get('tsk_…');             // null on 404
 *   const { steps } = await agents.runs.steps(run, { after: 10 });
 *   const started = await agents.runs.start('actor', { text: 'Find the bug' }, { budget: { usd: 1 } });
 *   await agents.runs.stop(started.id, { reason: 'not now' });
 *   await agents.approvals.answer(run, 7, 'approve');
 *   for await (const event of agents.events(run)) { … }     // AG-UI: RUN_STARTED, STEP_*, RUN_FINISHED, RUN_ERROR
 *
 * A product that implements the engine's routes serves them; point the client at that product with
 * { service: 'actor', audience: 'openvibe.actor' } (or { baseUrl }) when it is not Network:
 *   GET  /api/v1/runs?limit=&before=&status=&agent=&parent_run=
 *   GET  /api/v1/runs/:id
 *   GET  /api/v1/runs/:id/steps?after=&limit=
 *   POST /api/v1/runs                         { agent, input, budget?, parent_run? }
 *   POST /api/v1/runs/:id/stop                { reason? }
 *   POST /api/v1/runs/:id/approvals/:step     { answer }
 *   GET  /api/v1/runs/:id/events              AG-UI, Last-Event-ID resumes
 *
 * The plugin interfaces (model adapter, tool, sandbox, memory, planner, reviewer) are documented below as JSDoc
 * types only: the runtime that calls them lands in a later stage, and nothing here implements one.
 */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { parseSSE } = require('./realtime');
const enc = encodeURIComponent;
const pause = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const runIdOf = (run) => {
    if (typeof run === 'string') return run;
    if (run && typeof run === 'object' && typeof run.id === 'string') return run.id;
    return null;
};
function createAgentsClient(client, { baseUrl, service = 'network', audience = 'openvibe.network' } = {}) {
    const call = (opts) => client.request({ service, baseUrl, audience, ...opts });
    async function run(id, { signal } = {}) {
        if (!id) throw new TypeError('agents.run: id is required');
        try { return (await call({ path: `/api/v1/runs/${enc(id)}`, signal })).data; }
        catch (err) { if (isOpenVibeError(err) && err.status === 404) return null; throw err; }
    }
    async function get(id, { signal } = {}) {
        if (!id) throw new TypeError('agents.runs.get: id is required');
        try {
            return (await call({ path: `/api/v1/runs/${enc(id)}`, headers: { Accept: 'application/vnd.openvibe.agents.run+json' }, signal })).data;
        } catch (err) { if (isOpenVibeError(err) && err.status === 404) return null; throw err; }
    }
    async function list({ limit, before, status, agent, parentRun, signal } = {}) {
        return (await call({ path: '/api/v1/runs', query: { limit, before, status, agent, parent_run: parentRun }, signal })).data;
    }
    async function steps(id, { after, limit, signal } = {}) {
        const runId = runIdOf(id);
        if (!runId) throw new TypeError('agents.runs.steps: a run id or a run with an id is required');
        if (after != null && !Number.isInteger(Number(after))) throw new TypeError('agents.runs.steps: after must be a seq');
        return (await call({ path: `/api/v1/runs/${enc(runId)}/steps`, query: { after, limit }, signal })).data;
    }
    async function start(agent, input, { budget, parentRun, signal, idempotencyKey } = {}) {
        if (!agent || (typeof agent !== 'string' && typeof agent !== 'object')) throw new TypeError('agents.runs.start: an agent is required');
        if (input === undefined) throw new TypeError('agents.runs.start: an input is required');
        const body = { agent, input, ...(budget !== undefined ? { budget } : {}), ...(parentRun !== undefined ? { parent_run: parentRun } : {}) };
        return (await call({ method: 'POST', path: '/api/v1/runs', json: body, ...(idempotencyKey ? { idempotencyKey } : {}), signal })).data;
    }
    async function stop(id, { reason, signal } = {}) {
        const runId = runIdOf(id);
        if (!runId) throw new TypeError('agents.runs.stop: a run id or a run with an id is required');
        return (await call({ method: 'POST', path: `/api/v1/runs/${enc(runId)}/stop`, ...(reason !== undefined ? { json: { reason } } : {}), signal })).data;
    }
    async function answer(id, stepSeq, reply, { signal } = {}) {
        const runId = runIdOf(id);
        if (!runId) throw new TypeError('agents.approvals.answer: a run id or a run with an id is required');
        const step = Number(stepSeq);
        if (!Number.isInteger(step) || step < 1) throw new TypeError('agents.approvals.answer: a step seq is required');
        if (reply === undefined) throw new TypeError('agents.approvals.answer: an answer is required');
        return (await call({ method: 'POST', path: `/api/v1/runs/${enc(runId)}/approvals/${step}`, json: { answer: reply }, signal })).data;
    }
    async function post(id, approval, { signal } = {}) {
        if (!id) throw new TypeError('agents.post: id is required');
        if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new TypeError('agents.post: approval must be an object');
        return (await call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/approvals`, json: approval, signal })).data;
    }
    async function* events(run, { lastEventId = 0, signal, maxReconnects = 20, reconnectDelayMs = 1000 } = {}) {
        const id = runIdOf(run);
        if (!id) throw new TypeError('agents.events: a run id or a run with an id is required');
        let last = String(lastEventId || '0'), failures = 0, serverRetryMs = 0;
        while (!(signal && signal.aborted)) {
            let delivered = false;
            try {
                const res = await call({ path: `/api/v1/runs/${enc(id)}/events`, responseType: 'response', retries: 0, signal,
                    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': last } });
                if (res.status === 204) return;
                for await (const msg of parseSSE(res.data.body, { onRetry: (ms) => { serverRetryMs = ms; } })) {
                    if (msg.id !== undefined && msg.id !== '') { if (/^\d+$/.test(msg.id) && Number(msg.id) <= Number(last)) continue; last = msg.id; }
                    let data; try { data = JSON.parse(msg.data); } catch { data = null; }
                    delivered = true; failures = 0;
                    yield { id: msg.id ?? null, event: msg.event || (data && data.type) || null, data };
                    if (data && ['RUN_FINISHED', 'RUN_ERROR'].includes(data.type)) return;
                }
            } catch (err) {
                if (signal && signal.aborted) return;
                if (isOpenVibeError(err) && err.status >= 400 && err.status < 500) throw err;
                if (!isOpenVibeError(err) && !['TypeError', 'AbortError'].includes(err && err.name)) throw err;
            }
            failures = delivered ? 0 : failures + 1;
            if (failures > maxReconnects) throw new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: `agents: event stream ${id} failed ${failures} times in a row` });
            const backoffMs = Math.min(reconnectDelayMs * (2 ** Math.max(0, failures - 1)), 30000);
            const waitMs = Math.min(Math.max(backoffMs, serverRetryMs), 30000);
            await pause(waitMs, signal);
        }
    }
    return {
        run, events, post,
        runs: { list, get, steps, start, stop },
        approvals: { answer },
    };
}

/**
 * A model adapter is the only way the loop reaches a model: OpenVibe AI's routes, a person's own key, a Link
 * machine's local model or a signed-in plan. It returns the model's next turn and what it cost.
 * @typedef {object} AgentModelAdapter
 * @property {string} id             A stable id for the model (the picker's row id, e.g. "openvibe:deepseek-v4").
 * @property {string} [family]       The model family, for a reviewer of another family (Actor's check).
 * @property {(request: { messages: object[], tools?: AgentTool[], model?: string, budget?: object, signal?: AbortSignal }) => Promise<{ text?: string, tool_calls?: object[], usage?: { tokens?: number }, cost?: { usd?: number }, raw?: object }>} complete
 *   One turn: the words, the tool calls the model wants and what it spent.
 */

/**
 * A tool the loop may call. OpenVibe products are tools (Search, Media, Live, Bot, a Link machine); an MCP server
 * is a bag of them. The registry decides which the run may use; the tool never sees a credential it does not need.
 * @typedef {object} AgentTool
 * @property {string} name
 * @property {string} description
 * @property {object} [inputSchema]  JSON Schema for `input`.
 * @property {(input: object, context: { run: object, toolCall: object, signal?: AbortSignal }) => Promise<{ result: any, cost?: { usd?: number }, artifacts?: object[] }>} run
 */

/**
 * A sandbox is where code runs: a Codes worker, a Link machine or an OpenVibe computer. The loop asks; the sandbox
 * owns isolation, egress and the redaction of what it returns.
 * @typedef {object} AgentSandbox
 * @property {string} id
 * @property {string} [where]        "codes-worker" | "link-machine" | "run-computer" | "this-computer"
 * @property {(command: string | string[], options?: { cwd?: string, env?: object, timeoutMs?: number, signal?: AbortSignal }) => Promise<{ ok: boolean, output: string, exitCode?: number, artifacts?: object[] }>} exec
 * @property {(path: string, options?: { encoding?: string }) => Promise<string | Uint8Array>} [readFile]
 * @property {(path: string, data: string | Uint8Array) => Promise<{ path: string, bytes?: number }>} [writeFile]
 */

/**
 * Memory is what the run may remember between steps and runs: Actor's memories, Codes' knowledge, a person's own
 * notes. It is scoped to the owner; a run never reads another owner's memory.
 * @typedef {object} AgentMemory
 * @property {(query: { text?: string, kinds?: string[], limit?: number }) => Promise<object[]>} read
 * @property {(entry: { text: string, kind?: string, ref?: string, data?: object }) => Promise<object>} write
 * @property {(id: string) => Promise<boolean>} [forget]
 */

/**
 * The planner turns the person's input into a plan of steps before the loop runs. It is replaceable: Actor's plan
 * step, Codes' model plan or a strict no-plan adapter.
 * @typedef {object} AgentPlanner
 * @property {(input: { run: object, text: string, context?: object, signal?: AbortSignal }) => Promise<{ steps: Array<{ title: string, kind?: string, tool?: string }>, text?: string }>} plan
 */

/**
 * The reviewer checks a finished or in-flight run: a model of another family (Actor's check), a test suite, a
 * rubric. A run is never delivered as checked unless the reviewer passed it.
 * @typedef {object} AgentReviewer
 * @property {(input: { run: object, result: any, steps?: object[], signal?: AbortSignal }) => Promise<{ ok: boolean, reason?: string, by?: string, cross?: boolean }>} review
 */

module.exports = { createAgentsClient };
