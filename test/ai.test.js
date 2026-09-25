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
