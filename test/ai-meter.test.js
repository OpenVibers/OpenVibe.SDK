'use strict';
// openvibe-sdk/ai-meter (ai-metrics.md): usage from every provider's shape, TTFT and tokens per second from a call's own
// clock, records that fit ai.call-report@1, and a client that batches them to AI, retries what can be retried and never
// sends a refused batch again.
const assert = require('node:assert/strict');
const { run, stubServer } = require('./helpers');
const meter = require('../src/ai-meter');

run([
    ['normalize: OpenAI chat and Responses, Anthropic, Gemini, Ollama; INPUT is the uncached input', () => {
        assert.deepEqual(meter.normalize({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 50 } }), { input: 400, output: 200, reasoning: 50, cache_read: 600, cache_write: 0 });
        assert.deepEqual(meter.normalize({ prompt_tokens: 900, completion_tokens: 10, prompt_cache_hit_tokens: 800 }).cache_read, 800, 'DeepSeek’s name for a cache hit');
        assert.deepEqual(meter.normalize({ input_tokens: 1000, output_tokens: 300, input_tokens_details: { cached_tokens: 900 }, output_tokens_details: { reasoning_tokens: 120 } }), { input: 100, output: 300, reasoning: 120, cache_read: 900, cache_write: 0 });
        assert.deepEqual(meter.normalize({ input_tokens: 40, output_tokens: 250, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1200 }), { input: 40, output: 250, reasoning: 0, cache_read: 5000, cache_write: 1200 });
        assert.deepEqual(meter.normalize({ promptTokenCount: 2000, candidatesTokenCount: 100, cachedContentTokenCount: 1500, thoughtsTokenCount: 30 }), { input: 500, output: 100, reasoning: 30, cache_read: 1500, cache_write: 0 });
        const o = meter.normalize({ prompt_eval_count: 300, eval_count: 120, eval_duration: 9.6e9 });
        assert.deepEqual([o.input, o.output, o.ollama.eval_ms], [300, 120, 9600]);
        assert.deepEqual(meter.normalize(null), { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });
    }],
    ['a call: TTFT and latency from its own clock, less its queue; tokens per second after the first token', () => {
        let t = 10000;
        const call = meter.startCall({ system: 'actor', turn_id: 'tsk_1:3', provider: 'deepseek', model: 'deepseek-v4-flash', operation: 'chat', task: 'actor.task', task_id: 'tsk_1', harness: 'openvibe', place: 'provider', now: () => t });
        call.queued(200);
        t = 10800; call.firstToken();
        t = 11000; call.tool(); call.firstToken();
        t = 13800;
        const r = call.end({ usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } }, outcome: 'succeeded', fallbacks: 1 });
        assert.deepEqual([r.ttft_ms, r.latency_ms, r.tps, r.streamed, r.tool_calls, r.queue_ms, r.attempts, r.fallbacks], [600, 3600, 100, true, 1, 200, 2, 1]);
        assert.deepEqual([r.input, r.output, r.cache_read, r.operation, r.task, r.task_id, r.place, r.turn_id], [200, 300, 1000, 'chat', 'actor.task', 'tsk_1', 'provider', 'tsk_1:3']);
        assert.equal(r.charged_usd, undefined, 'no price: AI prices it');
    }],
    ['a call: Ollama’s own decode time; a charged price; a failure; too short to measure', () => {
        const local = meter.startCall({ system: 'node', run_id: 'cmd_1', provider: 'ollama', model: 'qwen2.5:3b', place: 'machine' }).end({ usage: { prompt_eval_count: 300, eval_count: 120, eval_duration: 9.6e9 } });
        assert.equal(local.tps, 12.5);
        assert.equal(local.ttft_ms, null, 'not streamed: no TTFT');
        const paid = meter.startCall({ system: 'actor', run_id: 'r2', provider: 'openrouter', model: 'x' }).end({ usage: {}, charged_usd: 0.0042 });
        assert.deepEqual([paid.charged_usd, paid.price_source], [0.0042, 'charged']);
        const bad = meter.startCall({ system: 'actor', run_id: 'r3', provider: 'p', model: 'm' }).end({ outcome: 'failed', error_class: 'rate_limited' });
        assert.deepEqual([bad.outcome, bad.error_class], ['failed', 'rate_limited']);
        assert.equal(meter.tokensPerSecond(5, 1000), null);
        assert.equal(meter.tokensPerSecond(100, 100), null);
        assert.throws(() => meter.startCall({ system: 'actor', provider: 'p', model: 'm' }), /run_id or turn_id/);
    }],
    ['the client: batches to AI with the service token; retries a 503; drops a refused batch once', async () => {
        const seen = [];
        let answer = 503;
        const srv = await stubServer(async (req, res, body) => {
            seen.push({ url: req.url, auth: req.headers.authorization, n: JSON.parse(body.toString()).calls.length });
            res.writeHead(answer, { 'content-type': 'application/json' }); res.end('{}');
        });
        try {
            const tokenClient = { getToken: async () => 'tok', invalidate() {} };
            const client = meter.createMeterClient({ aiUrl: srv.url, tokenClient, batch: 3, flushMs: 10000 });
            for (let i = 0; i < 3; i++) client.record({ system: 'actor', run_id: `r${i}`, provider: 'p', model: 'm', outcome: 'succeeded', at: new Date().toISOString() });
            await client.flush();
            assert.equal(seen[0].url, '/api/v1/usage/calls');
            assert.equal(seen[0].auth, 'Bearer tok');
            assert.equal(client.stats().queued, 3, 'a 503 keeps them');
            answer = 202;
            await client.flush();
            assert.deepEqual([client.stats().sent, client.stats().queued], [3, 0]);
            answer = 422;
            client.record({ system: 'actor', run_id: 'bad', provider: 'p', model: 'm', outcome: 'succeeded', at: 'x' });
            await client.close();
            assert.deepEqual([client.stats().rejected, client.stats().queued], [1, 0], 'refused once, never again');
        } finally { await srv.close(); }
    }],
]);
