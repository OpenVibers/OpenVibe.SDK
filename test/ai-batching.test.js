'use strict';
/** BA3 (track BA): the latency classes and the batches of OpenVibe.AI, against a fake AI. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createAiClient } = require('../src/ai');

// The fake AI: a run that stays queued (a batch run takes hours) and the batches queue.
async function fakeAi() {
    let polls = 0;
    return stubServer((req, res, body) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'POST' && u.pathname === '/api/v1/runs') {
            const b = JSON.parse(String(body));
            const batch = b.options && b.options.latency === 'batch';
            return send(res, 202, { run: { id: batch ? 'run_batch' : 'run_1', status: 'queued', latency_class: b.options ? b.options.latency : 'interactive' } });
        }
        if (u.pathname === '/api/v1/runs/run_1') { polls++; return send(res, 200, { run: { id: 'run_1', status: 'running' } }); }
        if (u.pathname === '/api/v1/runs/run_done') return send(res, 200, { run: { id: 'run_done', status: 'succeeded' } });
        if (u.pathname === '/api/v1/runs/run_batch') return send(res, 200, { run: { id: 'run_batch', status: 'queued', latency_class: 'batch' } });
        if (req.method === 'POST' && u.pathname === '/api/v1/batches') return send(res, 201, { batch: { id: 'bat_1', status: 'queued', item_count: 2 } });
        if (req.method === 'POST' && u.pathname === '/api/v1/batches/bat_1/cancel') return send(res, 200, { batch: { id: 'bat_1', status: 'cancelled' } });
        if (u.pathname === '/api/v1/batches/bat_1') return send(res, 200, { batch: { id: 'bat_1', status: 'succeeded', items: [{ idx: 0, status: 'succeeded', answer: 'the answer' }] } });
        if (u.pathname === '/api/v1/batches') return send(res, 200, { batches: [{ id: 'bat_1', status: 'succeeded' }] });
        return send(res, 404, { code: 'not_found' });
    });
}

const client = (srv) => createAiClient(createClient({ baseUrls: { ai: srv.url }, getToken: ({ audience }) => `svc-${audience}` }));

run([
    ['a run may ask for the class it may wait in, and for a batch a deadline', async () => {
        const srv = await fakeAi();
        const ai = client(srv);
        await ai.runs.create('blog.write_digest', { items: 2 }, { latency: 'batch', deadlineHours: 24, idempotencyKey: 'k-2' });
        const req = srv.requests[0];
        assert.equal(req.url, '/api/v1/runs');
        assert.deepEqual(JSON.parse(String(req.body)), {
            workflow: 'blog.write_digest', input: { items: 2 },
            options: { latency: 'batch', deadline_hours: 24 },
        });
        assert.equal(req.headers['idempotency-key'], 'k-2');
        // A run that asks for nothing says nothing: the body is the body it always was.
        await ai.runs.create('wiki.generate_page', { title: 'X' });
        assert.deepEqual(JSON.parse(String(srv.requests[1].body)), { workflow: 'wiki.generate_page', input: { title: 'X' } });
        await srv.close();
    }],
    ['waitFor gives a batch run back pending instead of throwing when the wait is over', async () => {
        const srv = await fakeAi();
        const ai = client(srv);
        const pending = await ai.runs.waitFor('run_batch', { intervalMs: 5, timeoutMs: 20 });
        assert.equal(pending.status, 'queued', 'the run is still queued');
        assert.equal(pending.latency_class, 'batch', 'and it says which class it is in');
        // An ordinary run still fails the wait: a caller that waits for it must hear about it.
        await assert.rejects(ai.runs.waitFor('run_1', { intervalMs: 5, timeoutMs: 20 }), /still running/);
        await srv.close();
    }],
    ['the batches: open, read, list and cancel', async () => {
        const srv = await fakeAi();
        const ai = client(srv);
        const opened = await ai.batches.create(['one prompt', 'another prompt'], { model: 'gpt-4o-mini', deadlineHours: 6, idempotencyKey: 'k-3' });
        assert.equal(opened.batch.id, 'bat_1');
        assert.equal(srv.requests[0].url, '/api/v1/batches');
        assert.deepEqual(JSON.parse(String(srv.requests[0].body)), { items: ['one prompt', 'another prompt'], model: 'gpt-4o-mini', deadline_hours: 6 });
        assert.equal(srv.requests[0].headers['idempotency-key'], 'k-3');
        const one = await ai.batches.get('bat_1');
        assert.equal(one.batch.items[0].answer, 'the answer');
        const many = await ai.batches.list();
        assert.equal(many.batches.length, 1);
        assert.equal(srv.requests[2].url, '/api/v1/batches');
        const cancelled = await ai.batches.cancel('bat_1');
        assert.equal(cancelled.batch.status, 'cancelled');
        assert.equal(srv.requests[3].url, '/api/v1/batches/bat_1/cancel');
        assert.equal(srv.requests[3].method, 'POST');
        await srv.close();
    }],
]);
