'use strict';
/** AI: create with wait and an idempotency key, no retried create without one, waitFor polls to the end, direct ops. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createAiClient } = require('../src/ai');

async function aiStub() {
    let polls = 0, busy = 0;
    return stubServer((req, res, body) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'POST' && u.pathname === '/api/v1/runs') {
            const b = JSON.parse(String(body));
            if (b.workflow === 'busy.flow' && busy++ === 0) return send(res, 503, { code: 'ai.busy' });
            return send(res, 202, { run: { id: 'run_1', status: 'queued' } });
        }
        if (u.pathname === '/api/v1/runs/run_1') return send(res, 200, { run: { id: 'run_1', status: ++polls >= 3 ? 'succeeded' : 'running', output: polls >= 3 ? { ok: true } : undefined } });
        if (u.pathname === '/api/v1/runs/missing') return send(res, 404, { code: 'run.not_found' });
        if (u.pathname === '/api/v1/summarize') return send(res, 201, { run: { id: 'run_2', status: 'succeeded' } });
        if (u.pathname === '/api/v1/creations') return send(res, 200, { creations: [{ id: 'blog-post', product: 'blog', name: 'Write a blog post' }], count: 1, generated_at: '2026-11-09T22:15:00.000Z' });
        if (req.method === 'POST' && u.pathname === '/api/v1/decisions') return send(res, 200, { answers: { is_spam: { type: 'noul', noul: 0.04, confidence: 0.96 } }, calibrated: true,
            receipt: { provider: 'gemini', model: 'gemini-decision-1', input_tokens: 120, cost_usd: 0.000012, steps: [{ step: 1, provider: 'gemini', model: 'gemini-decision-1', input_tokens: 120, cost_usd: 0.000012, calibrated: true, questions: ['is_spam'] }] } });
        if (u.pathname === '/api/v1/decisions/models') return send(res, 200, { models: [{ id: 'gemini/gemini-decision-1', provider: 'gemini', name: "Google's Decisions API", price_in_per_mtok: 0.1, price_out_per_mtok: 0, speed_p50_ms: null, calibrated: true, max_questions: 1000, inputs: ['text', 'image'], available: true }], count: 1, generated_at: '2026-11-14T10:00:00.000Z' });
        return send(res, 404, {});
    });
}

run([
    ['create sends workflow, input, wait and the idempotency key; waitFor polls until finished', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, getToken: ({ audience }) => `svc-${audience}` }));
        const r = await ai.runs.create('wiki.generate_page', { title: 'X' }, { wait: 2000, idempotencyKey: 'k-1', onBehalfOf: { type: 'user', id: 'usr_x' } });
        assert.equal(r.run.status, 'queued');
        const req = srv.requests[0];
        assert.equal(req.url, '/api/v1/runs?wait=2000');
        assert.deepEqual(JSON.parse(String(req.body)), { workflow: 'wiki.generate_page', input: { title: 'X' }, on_behalf_of: { type: 'user', id: 'usr_x' } });
        assert.equal(req.headers.authorization, 'Bearer svc-openvibe.ai');
        assert.equal(req.headers['idempotency-key'], 'k-1');
        const done = await ai.runs.waitFor('run_1', { intervalMs: 5 });
        assert.equal(done.status, 'succeeded');
        assert.equal(await ai.runs.get('missing'), null);
        await srv.close();
    }],
    ['creations reads the public catalogue without a token', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, token: 't', retries: 2 }));
        const list = await ai.creations();
        assert.equal(list.count, 1);
        assert.equal(list.creations[0].id, 'blog-post');
        assert.equal(srv.requests[0].url, '/api/v1/creations');
        assert.equal(srv.requests[0].headers.authorization, undefined, 'public: no token is sent');
        await srv.close();
    }],
    ['turn sends Media file references and the requested output file through ai.complete', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, token: 't' }));
        await ai.turn({ messages: [{ role: 'user', content: 'Summarize this file' }], files: [{ id: 'med_example' }],
            output_file: { name: 'answer.md', media_type: 'text/markdown' } },
        { wait: 1000, onBehalfOf: { type: 'user', id: 'usr_example' } });
        assert.deepEqual(JSON.parse(String(srv.requests[0].body)), {
            workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'Summarize this file' }], files: [{ id: 'med_example' }],
                output_file: { name: 'answer.md', media_type: 'text/markdown' } }, on_behalf_of: { type: 'user', id: 'usr_example' },
        });
        await srv.close();
    }],
    ['decide asks the questions with the model, the kind and the preference, and answers with the receipt', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, token: 't' }));
        const out = await ai.decide({ input: 'buy cheap pills', questions: { is_spam: { type: 'noul', instructions: 'Is this spam?' } },
            model: 'openai/gpt-4o-mini', kind: 'moderation', prefer: 'cheap' });
        assert.equal(out.answers.is_spam.noul, 0.04);
        assert.equal(out.answers.is_spam.confidence, 0.96);
        assert.equal(out.calibrated, true);
        assert.equal(out.receipt.model, 'gemini-decision-1');
        assert.equal(out.receipt.steps.length, 1);
        assert.equal(out.receipt.steps[0].cost_usd, 0.000012);
        const req = srv.requests[0];
        assert.equal(req.url, '/api/v1/decisions');
        assert.deepEqual(JSON.parse(String(req.body)), {
            input: 'buy cheap pills', questions: { is_spam: { type: 'noul', instructions: 'Is this spam?' } },
            model: 'openai/gpt-4o-mini', kind: 'moderation', prefer: 'cheap',
        });
        await srv.close();
    }],
    ['decide sends only what the caller gave, and the models list is public', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, token: 't' }));
        await ai.decide({ input: 'x', questions: { a: { type: 'noul', instructions: 'y' } } });
        assert.deepEqual(JSON.parse(String(srv.requests[0].body)), { input: 'x', questions: { a: { type: 'noul', instructions: 'y' } } });
        const list = await ai.decideModels();
        assert.equal(list.count, 1);
        assert.equal(list.models[0].id, 'gemini/gemini-decision-1');
        assert.equal(list.models[0].calibrated, true);
        assert.equal(srv.requests[1].url, '/api/v1/decisions/models');
        assert.equal(srv.requests[1].headers.authorization, undefined, 'public: no token is sent');
        await srv.close();
    }],
    ['a create without a key is not retried; direct ops post the input as the body', async () => {
        const srv = await aiStub();
        const ai = createAiClient(createClient({ baseUrls: { ai: srv.url }, token: 't', retries: 2 }));
        await assert.rejects(ai.runs.create('busy.flow', {}), (e) => e.status === 503);
        assert.equal(srv.requests.length, 1, 'one attempt');
        const s = await ai.summarize({ text: 'long text' }, { wait: 30000 });
        assert.equal(s.run.id, 'run_2');
        assert.equal(srv.requests[1].url, '/api/v1/summarize?wait=30000');
        assert.deepEqual(JSON.parse(String(srv.requests[1].body)), { text: 'long text' });
        await srv.close();
    }],
]);
