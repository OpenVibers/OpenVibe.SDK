'use strict';
/**
 * openvibe-sdk/ai-meter — every product meters its AI calls the same way (ai-metrics.md; ai.call.recorded@1 1.1.0 and
 * ai.call-report@1). A call that did not go through OpenVibe.AI (Actor's own model calls, a Codes harness turn, a local
 * model on a person's machine, Vibe) is recorded here and sent to AI's POST /api/v1/usage/calls, which prices it when it
 * brings no price and publishes it, so every AI call on the network is in one meter.
 *
 *   (meter is this module, openvibe-sdk/ai-meter)
 *   const call = meter.startCall({ system: 'actor', turn_id, provider: 'deepseek', model, operation: 'chat', task: 'actor.task', task_id, streamed: true });
 *   …on the first streamed token: call.firstToken();   on each tool call the model asks for: call.tool();
 *   const record = call.end({ usage: providerUsage, outcome: 'succeeded' });   // ai.call-report@1's item
 *   client.record(record);
 *
 *   normalize(usage)              → { input, output, reasoning, cache_read, cache_write, ollama } from OpenAI (chat and
 *                                    Responses), Anthropic, Gemini and Ollama usage objects; INPUT is the uncached input
 *   tokensPerSecond(output, ms)   → the decode speed, or null when too short to measure
 *   createMeterClient({ aiUrl, tokenClient, fetch, batch, flushMs, maxQueue, log })
 *                                 → { record(rec), flush(), close(), stats() }: batches of up to 100, retried with backoff
 *                                    on a network error, 408, 425, 429 or 5xx; a 401 asks the token client again; any
 *                                    other refusal drops that batch and counts it (a call is never sent twice: AI keys
 *                                    each by system + run or turn id anyway).
 * Server and browser: no I/O but the client's fetch.
 */

const OPERATIONS = ['chat', 'completion', 'embedding', 'image', 'image_edit', 'speech', 'transcription', 'translation', 'rerank', 'moderation', 'decision', 'realtime', 'batch', 'tool', 'other'];
const PLACES = ['provider', 'machine', 'community', 'plan', 'host'];
const OUTCOMES = ['succeeded', 'failed', 'cancelled', 'cached'];
const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);

/** Usage from any provider's shape, with INPUT the uncached input tokens (as ai.call.recorded@1 counts them). */
function normalize(u) {
    if (!u || typeof u !== 'object') return { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
    // OpenAI chat completions (and compatible providers; DeepSeek names its cache hits prompt_cache_hit_tokens).
    if (u.prompt_tokens != null || u.completion_tokens != null) {
        const cached = n((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens);
        return { input: Math.max(0, n(u.prompt_tokens) - cached), output: n(u.completion_tokens), reasoning: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens), cache_read: cached, cache_write: 0 };
    }
    // OpenAI Responses API: input_tokens includes the cached ones, given in input_tokens_details.
    if (u.input_tokens != null && (u.input_tokens_details || u.output_tokens_details)) {
        const cached = n(u.input_tokens_details && u.input_tokens_details.cached_tokens);
        return { input: Math.max(0, n(u.input_tokens) - cached), output: n(u.output_tokens), reasoning: n(u.output_tokens_details && u.output_tokens_details.reasoning_tokens), cache_read: cached, cache_write: 0 };
    }
    // Anthropic Messages: input_tokens already excludes the cache, read and written apart.
    if (u.input_tokens != null || u.output_tokens != null) {
        return { input: n(u.input_tokens), output: n(u.output_tokens), reasoning: 0, cache_read: n(u.cache_read_input_tokens), cache_write: n(u.cache_creation_input_tokens) };
    }
    // Gemini usageMetadata.
    if (u.promptTokenCount != null || u.candidatesTokenCount != null) {
        const cached = n(u.cachedContentTokenCount);
        return { input: Math.max(0, n(u.promptTokenCount) - cached), output: n(u.candidatesTokenCount), reasoning: n(u.thoughtsTokenCount), cache_read: cached, cache_write: 0 };
    }
    // Ollama: counts and its own decode time (nanoseconds).
    if (u.prompt_eval_count != null || u.eval_count != null) {
        return { input: n(u.prompt_eval_count), output: n(u.eval_count), reasoning: 0, cache_read: 0, cache_write: 0, ollama: { eval_ms: u.eval_duration != null ? Number(u.eval_duration) / 1e6 : null } };
    }
    // Already normalized.
    return { input: n(u.input), output: n(u.output), reasoning: n(u.reasoning), cache_read: n(u.cache_read), cache_write: n(u.cache_write) };
}

/** Output tokens per second over the decode time; null below 8 tokens or 200 ms (noise, not speed). */
function tokensPerSecond(output, ms) {
    if (!(output >= 8) || !(ms >= 200)) return null;
    return Math.round((output / (ms / 1000)) * 10) / 10;
}

function startCall(o = {}) {
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const started = now();
    let first = null; let queue = null; let tools = 0;
    if (!o.system || !o.provider || !o.model) throw new TypeError('startCall: system, provider and model are required');
    if (o.run_id == null && o.turn_id == null) throw new TypeError('startCall: run_id or turn_id is required (the idempotency key)');
    const call = {
        queued(ms) { queue = n(ms); return call; },
        firstToken() { if (first == null) first = now(); return call; },
        tool(count = 1) { tools += n(count); return call; },
        end(e = {}) {
            const end = now();
            const t = normalize(e.usage);
            const outcome = OUTCOMES.includes(e.outcome) ? e.outcome : 'succeeded';
            const decodeMs = t.ollama && t.ollama.eval_ms != null ? t.ollama.eval_ms : (first != null ? end - first : null);
            const rec = {
                system: String(o.system).slice(0, 100), provider: String(o.provider).slice(0, 120), model: String(o.model).slice(0, 200),
                ...(o.run_id != null ? { run_id: String(o.run_id) } : { turn_id: String(o.turn_id) }),
                surface: String(o.surface || o.task || o.system), outcome, at: new Date(end).toISOString(),
                input: t.input, output: t.output, reasoning: t.reasoning, cache_read: t.cache_read, cache_write: t.cache_write,
                latency_ms: Math.max(0, end - started - (queue || 0)), ttft_ms: first != null ? Math.max(0, first - started - (queue || 0)) : null,
                attempts: 1 + n(e.fallbacks),
                streamed: o.streamed === true || first != null, tps: decodeMs != null ? tokensPerSecond(t.output, decodeMs) : null,
            };
            if (OPERATIONS.includes(o.operation)) rec.operation = o.operation;
            if (PLACES.includes(o.place)) rec.place = o.place;
            for (const k of ['task', 'task_id', 'harness', 'region', 'subject', 'attribution', 'paid_by', 'effort']) if (o[k] != null) rec[k] = o[k];
            if (queue != null) rec.queue_ms = queue;
            if (tools) rec.tool_calls = tools;
            if (e.fallbacks != null) rec.fallbacks = n(e.fallbacks);
            if (e.cache_hit != null) rec.cache_hit = !!e.cache_hit;
            if (e.error_class) rec.error_class = String(e.error_class).slice(0, 60);
            if (e.task_ms != null) rec.task_ms = n(e.task_ms);
            if (e.charged_usd != null && Number.isFinite(Number(e.charged_usd))) { rec.charged_usd = Number(e.charged_usd); rec.price_source = 'charged'; }
            if (e.images != null) rec.images = n(e.images);
            if (e.audio_seconds != null) rec.audio_seconds = Number(e.audio_seconds) || 0;
            return rec;
        },
    };
    return call;
}

function createMeterClient({ aiUrl, tokenClient = null, fetch: fetchImpl = globalThis.fetch, batch = 50, flushMs = 2000, maxQueue = 5000, log = console, audience = 'openvibe.ai' } = {}) {
    if (!aiUrl) throw new TypeError('createMeterClient: aiUrl is required');
    const base = String(aiUrl).replace(/\/+$/, '');
    const size = Math.max(1, Math.min(100, Number(batch) || 50));
    const queue = [];
    const stats = { sent: 0, dropped: 0, rejected: 0, retried: 0 };
    let timer = null; let busy = null; let backoff = 0; let closed = false;
    const schedule = (ms) => { if (!timer && !closed) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, ms); if (timer.unref) timer.unref(); } };
    function record(rec) {
        if (!rec || typeof rec !== 'object') return false;
        queue.push(rec);
        while (queue.length > maxQueue) { queue.shift(); stats.dropped += 1; }
        if (queue.length >= size) flush().catch(() => {}); else schedule(flushMs);
        return true;
    }
    async function send(calls, retry401 = true) {
        const headers = { 'content-type': 'application/json' };
        if (tokenClient && typeof tokenClient.getToken === 'function') headers.authorization = `Bearer ${await tokenClient.getToken({ audience })}`;
        const res = await fetchImpl(`${base}/api/v1/usage/calls`, { method: 'POST', headers, body: JSON.stringify({ calls }) });
        if (res.status === 401 && retry401 && tokenClient && typeof tokenClient.invalidate === 'function') { tokenClient.invalidate(); return send(calls, false); }
        return res.status;
    }
    async function flush() {
        if (busy) return busy;
        busy = (async () => {
            while (queue.length) {
                const calls = queue.slice(0, size);
                let status;
                try { status = await send(calls); } catch { status = 0; }
                if (status >= 200 && status < 300) { queue.splice(0, calls.length); stats.sent += calls.length; backoff = 0; continue; }
                if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 || status === 401) {
                    stats.retried += 1;
                    backoff = Math.min(60000, backoff ? backoff * 2 : 1000);
                    schedule(backoff);
                    return;
                }
                queue.splice(0, calls.length); stats.rejected += calls.length;
                if (log && log.warn) log.warn(`[ai-meter] AI refused ${calls.length} call record(s): HTTP ${status}`);
            }
        })().finally(() => { busy = null; });
        return busy;
    }
    async function close() { closed = true; if (timer) { clearTimeout(timer); timer = null; } await flush(); }
    return { record, flush, close, stats: () => ({ ...stats, queued: queue.length }) };
}

module.exports = { startCall, normalize, tokensPerSecond, createMeterClient, OPERATIONS, PLACES, OUTCOMES };
