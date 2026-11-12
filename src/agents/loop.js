'use strict';
/**
 * openvibe-sdk/agents/loop — the light agent loop (agent-engine.md §9): a model, tools, and the person's words, turned
 * into a run's thread. It runs chat and ask turns on a server with no workspace (Vibe answering, an agent using
 * OpenVibe's own products as tools); work with files and commands goes to a harness through agents/acp.
 *
 *   // import { runLoop, createStepSink } from the openvibe-sdk/agents/loop entry
 *   const out = await runLoop({
 *     model,                                   // AgentModelAdapter (below): one turn per call
 *     tools: [search, remind],                 // AgentLoopTool (below)
 *     system: 'You are Vibe, on OpenVibe.',
 *     messages: history,                       // the thread so far (not emitted again)
 *     prompts: [{ role: 'user', text: 'Remind me to stretch every 2 hours' }],   // what is new: emitted, then answered
 *     budget: { usd: 0.05, tokens: 40000, turns: 12 },
 *     beforeToolCall: async ({ toolCall, input }) => (needsYes(toolCall) ? await askThePerson(toolCall) : undefined),
 *     steering: () => queue.splice(0),        // words the person sent while it works: taken before the next turn
 *     onEvent: createStepSink({ append, update, delta }),   // the run's steps (agents.step@1), as it goes
 *     signal,
 *   });
 *   // → { messages, stop: 'done' | 'terminated' | 'budget' | 'turns' | 'aborted' | 'error', usage, cost, turns }
 *
 * The model adapter (agents.js's AgentModelAdapter):
 *   model.complete({ messages, tools, system, signal, onDelta }) → { text, thinking, tool_calls: [{ id, name, input }],
 *     stop: 'stop' | 'tool_use' | 'length' | 'error' | 'aborted', usage: { tokens }, cost: { usd }, error }
 *   onDelta({ text } | { thinking }) streams the turn as it is written. Messages are { role: 'system' | 'user' |
 *   'assistant' | 'tool', text, thinking, tool_calls, tool_call_id, name, is_error }; one marked ui_only stays in the
 *   thread and never reaches the model.
 *
 * A tool (AgentTool, plus what the loop reads):
 *   { name, description, inputSchema, run(input, { toolCall, signal, onUpdate, run }) → { result, cost, artifacts,
 *     terminate, is_error }, sequential?, idempotent?, timeoutMs?, title?, glyph?, prepareInput?(input) }
 *
 * What it keeps, whatever the hooks say: a tool call cut off by the token limit is never run (the model is told to
 * send it again); an unknown tool, input its schema refuses, a blocked call, a throw or a timeout comes back to the
 * model as an error result, never as a crash; the same call repeated past `repeatLimit` gets a reminder instead of a
 * run; an idempotent tool's same call is answered from the run's memo; a tool's output is clipped before the model sees
 * it (`toolOutputLimit`); the budget stops the loop between turns, never in the middle of one.
 *
 * Ported from pi's agent loop (earendil-works/pi, packages/agent/src/agent-loop.ts), MIT License, Copyright (c) 2025
 * Mario Zechner. The structure is pi's: an inner loop over tool calls and steering, an outer loop over follow-ups, a
 * turn hook that may end or continue, tools in parallel (prepared in order, run together, results kept in the model's
 * order) or in sequence, beforeToolCall and afterToolCall. The model API, the message shape, the budget, the memo, the
 * repeat guard, the timeouts and the step sink are OpenVibe's.
 */

const DEFAULTS = { maxTurns: 50, repeatLimit: 3, toolTimeoutMs: 120000, toolOutputLimit: 20000 };
const STOPS = ['done', 'terminated', 'budget', 'turns', 'aborted', 'error'];

function stableJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

/** A small JSON Schema check for tool input (type, required, properties, enum, items; the subset tools use). */
function checkInput(schema, value, at = 'input') {
    if (!schema || typeof schema !== 'object') return null;
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
    if (types) {
        const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const ok = types.some((t) => t === kind || (t === 'integer' && Number.isInteger(value)) || (t === 'number' && kind === 'number'));
        if (!ok) return `${at} should be ${types.join(' or ')}`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => stableJson(e) === stableJson(value))) return `${at} should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const k of Array.isArray(schema.required) ? schema.required : []) if (!(k in value)) return `${at}.${k} is required`;
        const props = schema.properties || {};
        for (const [k, sub] of Object.entries(props)) if (k in value) { const e = checkInput(sub, value[k], `${at}.${k}`); if (e) return e; }
        if (schema.additionalProperties === false) { const extra = Object.keys(value).find((k) => !(k in props)); if (extra) return `${at}.${extra} is not an input of this tool`; }
    }
    if (Array.isArray(value) && schema.items) for (let i = 0; i < value.length; i++) { const e = checkInput(schema.items, value[i], `${at}[${i}]`); if (e) return e; }
    return null;
}

const errorResult = (message, extra = {}) => ({ result: { error: String(message) }, isError: true, ...extra });
const now = () => Date.now();

/**
 * Run the loop until the model stops asking for tools and nobody has said anything more, a tool ends it, the budget or
 * the turn limit is reached, or the signal aborts. Resolves with the new messages and why it stopped; never rejects for
 * a model or tool failure (stop: 'error' carries it), only for a call it cannot start (no model).
 */
async function runLoop(o = {}) {
    if (!o.model || typeof o.model.complete !== 'function') throw new TypeError('agents/loop: a model adapter with complete() is required');
    const cfg = { ...DEFAULTS, ...o };
    const tools = Array.isArray(o.tools) ? o.tools.filter((t) => t && typeof t.name === 'string' && typeof t.run === 'function') : [];
    const signal = o.signal;
    const emit = async (event) => { if (typeof o.onEvent === 'function') await o.onEvent(event); };
    const thread = Array.isArray(o.messages) ? o.messages.slice() : [];
    const added = [];
    const totals = { tokens: 0, usd: 0, turns: 0, toolCalls: 0 };
    const memo = new Map();
    const repeats = new Map();
    const budget = o.budget || {};
    const overBudget = () => (budget.usd != null && totals.usd >= budget.usd) || (budget.tokens != null && totals.tokens >= budget.tokens)
        || (budget.turns != null && totals.turns >= budget.turns) || (budget.steps != null && totals.turns + totals.toolCalls >= budget.steps);
    const take = async (fn) => { try { const v = typeof fn === 'function' ? await fn() : null; return Array.isArray(v) ? v.filter(Boolean) : []; } catch { return []; } };
    const push = async (m) => { thread.push(m); added.push(m); await emit({ type: 'message_start', message: m }); await emit({ type: 'message_end', message: m }); };

    let stop = 'done', error = null, terminated = false, explicit = false;
    await emit({ type: 'agent_start' });
    let pending = (Array.isArray(o.prompts) ? o.prompts.filter(Boolean) : []).concat(await take(o.steering));

    outer: for (;;) {
        let more = true;
        while (more || pending.length) {
            await emit({ type: 'turn_start' });
            for (const m of pending) await push({ at: now(), ...m });
            pending = [];
            if (signal && signal.aborted) { stop = 'aborted'; break outer; }
            if (overBudget()) { stop = 'budget'; break outer; }
            if (totals.turns >= cfg.maxTurns) { stop = 'turns'; break outer; }

            let visible = thread;
            if (typeof o.transformContext === 'function') { try { visible = (await o.transformContext(thread.slice(), signal)) || thread; } catch { visible = thread; } }
            const forModel = visible.filter((m) => m && !m.ui_only);
            const assistant = await callModel(o.model, { messages: forModel, tools, system: o.system, signal, budgetLeft: left(budget, totals) }, emit);
            thread.push(assistant); added.push(assistant);
            totals.turns += 1;
            totals.tokens += (assistant.usage && assistant.usage.tokens) || 0;
            totals.usd += (assistant.cost && assistant.cost.usd) || 0;

            if (assistant.stop === 'error' || assistant.stop === 'aborted') {
                await emit({ type: 'turn_end', message: assistant, toolResults: [] });
                stop = assistant.stop; error = assistant.error || null;
                break outer;
            }

            const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
            const results = [];
            more = false;
            if (calls.length) {
                const batch = assistant.stop === 'length' ? await failTruncated(calls) : await runTools(calls, assistant);
                for (const r of batch.messages) { thread.push(r); added.push(r); results.push(r); }
                terminated = batch.terminate;
                more = !batch.terminate;
            }
            let decision = null;
            if (typeof o.finishTurn === 'function') { try { decision = await o.finishTurn({ assistant, results, messages: thread, added, totals: { ...totals } }); } catch { decision = null; } }
            await emit({ type: 'turn_end', message: assistant, toolResults: results });
            if (decision && decision.action === 'end') { stop = 'done'; break outer; }
            explicit = !!(decision && decision.action === 'continue');
            pending = await take(o.steering);
            if (more || pending.length) explicit = false;
        }
        const follow = await take(o.followUp);
        if (follow.length) { explicit = false; terminated = false; pending = follow; continue; }
        if (explicit) { explicit = false; continue; }
        if (terminated) stop = 'terminated';
        break;
    }

    await emit({ type: 'agent_end', messages: added, stop, error });
    return { messages: added, stop, error, usage: { tokens: totals.tokens }, cost: { usd: Math.round(totals.usd * 1e6) / 1e6 }, turns: totals.turns, toolCalls: totals.toolCalls };

    // ── tools ──
    async function failTruncated(calls) {
        const messages = [];
        for (const call of calls) {
            await emit({ type: 'tool_start', toolCall: call });
            const done = { toolCall: call, ...errorResult(`The tool call "${call.name}" was not run: the answer hit the output limit, so its input may be cut off. Send the call again with its whole input.`) };
            messages.push(await finish(done));
        }
        return { messages, terminate: false };
    }

    async function runTools(calls, assistant) {
        const sequential = cfg.toolExecution === 'sequential' || calls.some((c) => { const t = tools.find((x) => x.name === c.name); return t && t.sequential; });
        const entries = [];
        for (const call of calls) {
            await emit({ type: 'tool_start', toolCall: call });
            totals.toolCalls += 1;
            const prep = await prepare(call, assistant);
            if (prep.immediate) {
                const done = { toolCall: call, ...prep.immediate };
                await emit({ type: 'tool_end', toolCall: call, result: done.result, isError: done.isError });
                entries.push(done);
            } else if (sequential) {
                entries.push(await execute(prep, assistant));
            } else {
                entries.push(() => execute(prep, assistant));
            }
            if (signal && signal.aborted) break;
        }
        const done = await Promise.all(entries.map((e) => (typeof e === 'function' ? e() : e)));
        const messages = [];
        for (const d of done) messages.push(await finish(d, true));
        return { messages, terminate: done.length > 0 && done.every((d) => d.terminate === true) };
    }

    async function prepare(call, assistant) {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { immediate: errorResult(`There is no tool named ${call.name}.`) };
        let input = call.input && typeof call.input === 'object' ? call.input : {};
        try {
            if (typeof tool.prepareInput === 'function') input = tool.prepareInput(input) || input;
            const bad = checkInput(tool.inputSchema, input);
            if (bad) return { immediate: errorResult(`The input does not fit ${tool.name}: ${bad}.`) };
            const key = `${tool.name} ${stableJson(input)}`;
            const n = (repeats.get(key) || 0) + 1;
            repeats.set(key, n);
            if (n > cfg.repeatLimit) return { immediate: errorResult(`You already called ${tool.name} with this same input ${n - 1} times. Use what it returned, or try something else.`) };
            if (tool.idempotent && memo.has(key)) return { immediate: { ...memo.get(key), memo: true } };
            if (typeof o.beforeToolCall === 'function') {
                const gate = await o.beforeToolCall({ toolCall: call, input, tool, assistant, messages: thread }, signal);
                if (signal && signal.aborted) return { immediate: errorResult('Stopped.') };
                if (gate && gate.block) return { immediate: errorResult(gate.reason || 'This call was not allowed.', gate.terminate === true ? { terminate: true } : {}) };
            }
            if (signal && signal.aborted) return { immediate: errorResult('Stopped.') };
            return { tool, call, input, key };
        } catch (err) {
            return { immediate: errorResult((err && err.message) || err) };
        }
    }

    async function execute(prep, assistant) {
        const { tool, call, input } = prep;
        const started = now();
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
        const limit = Number(tool.timeoutMs || cfg.toolTimeoutMs) || DEFAULTS.toolTimeoutMs;
        let timer = null;
        let out;
        try {
            const ran = Promise.resolve(tool.run(input, { toolCall: call, signal: ctl.signal, run: o.run || null, onUpdate: (partial) => emit({ type: 'tool_update', toolCall: call, partial }) }));
            // The timeout is settled before the tool is told to stop, so a tool that answers its abort never wins the race.
            const timeout = new Promise((resolve) => { timer = setTimeout(() => { resolve({ timedOut: true }); ctl.abort(); }, limit); });
            const got = await Promise.race([ran, timeout]);
            if (got && got.timedOut) out = errorResult(`${tool.name} took longer than ${limit < 1000 ? `${limit} ms` : `${Math.round(limit / 1000)} s`} and was stopped.`);
            else {
                const r = got && typeof got === 'object' && ('result' in got || 'is_error' in got || 'terminate' in got) ? got : { result: got };
                out = { result: r.result, isError: r.is_error === true, terminate: r.terminate === true, cost: r.cost || null, artifacts: Array.isArray(r.artifacts) ? r.artifacts : [] };
            }
        } catch (err) {
            out = errorResult((err && err.message) || err);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
        if (typeof o.afterToolCall === 'function') {
            try {
                const after = await o.afterToolCall({ toolCall: call, input, tool, assistant, result: out.result, isError: out.isError, messages: thread }, signal);
                if (after) out = { ...out, ...('result' in after ? { result: after.result } : {}), ...('isError' in after ? { isError: !!after.isError } : {}), ...('terminate' in after ? { terminate: !!after.terminate } : {}) };
            } catch (err) { out = errorResult((err && err.message) || err); }
        }
        if (out.cost && typeof out.cost.usd === 'number') totals.usd += out.cost.usd;
        if (tool.idempotent && !out.isError) memo.set(prep.key, { result: out.result, isError: false });
        const done = { toolCall: call, ...out, durationMs: now() - started };
        await emit({ type: 'tool_end', toolCall: call, result: done.result, isError: done.isError, durationMs: done.durationMs });
        return done;
    }

    async function finish(done, ended) {
        if (!ended) await emit({ type: 'tool_end', toolCall: done.toolCall, result: done.result, isError: done.isError });
        let text = typeof done.result === 'string' ? done.result : JSON.stringify(done.result === undefined ? null : done.result);
        if (text.length > cfg.toolOutputLimit) text = `${text.slice(0, cfg.toolOutputLimit)}\n[… ${text.length - cfg.toolOutputLimit} more characters left out]`;
        const m = { role: 'tool', tool_call_id: done.toolCall.id, name: done.toolCall.name, text, result: done.result, is_error: !!done.isError, at: now() };
        if (done.durationMs != null) m.duration_ms = done.durationMs;
        if (done.memo) m.memo = true;
        if (done.artifacts && done.artifacts.length) m.artifacts = done.artifacts;
        await emit({ type: 'message_start', message: m });
        await emit({ type: 'message_end', message: m });
        return m;
    }
}

function left(budget, totals) {
    const out = {};
    if (budget.usd != null) out.usd = Math.max(0, budget.usd - totals.usd);
    if (budget.tokens != null) out.tokens = Math.max(0, budget.tokens - totals.tokens);
    if (budget.turns != null) out.turns = Math.max(0, budget.turns - totals.turns);
    return Object.keys(out).length ? out : null;
}

/** One turn of the model, streamed into message_update events; a throw becomes stop: 'error' (or 'aborted'). */
async function callModel(model, request, emit) {
    const message = { role: 'assistant', text: '', thinking: '', tool_calls: [], at: now() };
    await emit({ type: 'message_start', message: { ...message } });
    let turn;
    try {
        turn = await model.complete({
            ...request,
            onDelta: (d) => {
                if (!d) return;
                if (typeof d.text === 'string') message.text += d.text;
                if (typeof d.thinking === 'string') message.thinking += d.thinking;
                return emit({ type: 'message_update', message: { ...message }, delta: d });
            },
        });
    } catch (err) {
        const aborted = request.signal && request.signal.aborted;
        const out = { ...message, stop: aborted ? 'aborted' : 'error', error: aborted ? 'Stopped.' : String((err && err.message) || err) };
        await emit({ type: 'message_end', message: out });
        return out;
    }
    const t = turn || {};
    const calls = (Array.isArray(t.tool_calls) ? t.tool_calls : []).filter((c) => c && typeof c.name === 'string')
        .map((c, i) => ({ id: String(c.id || `call_${now().toString(36)}_${i}`), name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} }));
    const out = {
        role: 'assistant', at: message.at,
        text: typeof t.text === 'string' ? t.text : message.text,
        thinking: typeof t.thinking === 'string' ? t.thinking : message.thinking,
        tool_calls: calls,
        stop: ['stop', 'tool_use', 'length', 'error', 'aborted'].includes(t.stop) ? t.stop : calls.length ? 'tool_use' : 'stop',
        usage: t.usage || null, cost: t.cost || null,
    };
    if (t.error) out.error = String(t.error);
    if (!out.thinking) delete out.thinking;
    if (!out.tool_calls.length) delete out.tool_calls;
    await emit({ type: 'message_end', message: out });
    return out;
}

/**
 * The loop's events as a run's steps (agents.step@1): the person's words, the agent's thinking (folded) and words, and
 * one step per tool call, updated when it ends. `append(step)` stores a step and may return it; `update(seq, patch)`
 * changes one (a tool that ended, words that finished); `delta(seq, text)` is more text for a step being written.
 * Seqs count from `startSeq` (the run's last seq + 1); `turn` starts at `startTurn` and a person's message opens the
 * next one.
 */
function createStepSink({ append, update, delta, runId = null, startSeq = 1, startTurn = 0, toolTitle } = {}) {
    if (typeof append !== 'function') throw new TypeError('agents/loop: createStepSink needs append(step)');
    let seq = startSeq, turn = startTurn, writing = null, thinking = null;
    const tools = new Map();
    const iso = () => new Date().toISOString();
    const add = async (step) => { const st = { run_id: runId, seq: seq++, turn, started_at: iso(), ...step }; await append(st); return st; };
    const patch = async (n, p) => { if (typeof update === 'function') await update(n, p); };
    const more = async (n, t) => { if (typeof delta === 'function') await delta(n, t); };
    return async function onEvent(e) {
        if (!e || !e.type) return;
        const m = e.message;
        if (e.type === 'message_update' && m && m.role === 'assistant' && e.delta) {
            if (typeof e.delta.thinking === 'string' && e.delta.thinking) {
                if (!thinking) thinking = await add({ kind: 'think', from: 'agent', status: 'running', title: 'Thinking', text: '' });
                await more(thinking.seq, e.delta.thinking);
            }
            if (typeof e.delta.text === 'string' && e.delta.text) {
                if (!writing) writing = await add({ kind: 'message', from: 'agent', status: 'running', text: '' });
                await more(writing.seq, e.delta.text);
            }
            return;
        }
        if (e.type === 'tool_start' && e.toolCall) {
            const c = e.toolCall;
            const st = await add({ kind: 'tool', from: 'tool', status: 'running', title: (typeof toolTitle === 'function' && toolTitle(c)) || c.name, tool_call: { name: c.name, input: c.input || {} } });
            tools.set(c.id, st.seq);
            return;
        }
        if (e.type === 'tool_end' && e.toolCall && tools.has(e.toolCall.id)) {
            await patch(tools.get(e.toolCall.id), { status: e.isError ? 'failed' : 'done', result: e.result === undefined ? null : e.result, ended_at: iso() });
            return;
        }
        if (e.type !== 'message_end' || !m) return;
        if (m.role === 'user') {
            // A person's message opens a turn (the run's first words are turn 0).
            if (seq > startSeq || turn > startTurn) turn += 1;
            await add({ kind: 'message', from: 'person', status: 'done', text: String(m.text || ''), ended_at: iso() });
            return;
        }
        if (m.role !== 'assistant' || !m.stop) return;
        const failed = m.stop === 'error';
        if (thinking) await patch(thinking.seq, { status: 'done', text: m.thinking || '', ended_at: iso() });
        else if (m.thinking) await add({ kind: 'think', from: 'agent', status: 'done', title: 'Thinking', text: m.thinking, ended_at: iso() });
        if (writing) await patch(writing.seq, { status: failed ? 'failed' : 'done', text: m.text || '', ended_at: iso() });
        else if (m.text) await add({ kind: 'message', from: 'agent', status: failed ? 'failed' : 'done', text: m.text, ended_at: iso() });
        else if (failed) await add({ kind: 'message', from: 'system', status: 'failed', text: m.error || 'The model did not answer.', ended_at: iso() });
        writing = null; thinking = null;
    };
}

module.exports = { runLoop, createStepSink, checkInput, STOPS, DEFAULTS };
