'use strict';
/** Bench API routes, envelopes, streaming JSONL, MCP, auth and problem errors. */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient, OpenVibeError } = require('../src/core');
const { createBenchClient } = require('../src/bench');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

async function bench() {
    return stubServer((req, res, body) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/datasets/vision.jsonl') {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.write('{"type":"task","id":"t1"}\n{"type":"rou');
            res.end('nd","id":"r1"}\n');
            return;
        }
        if (u.pathname === '/api/v1/kinds/missing') return problem(res, 404, 'bench.kind_not_found', 'No such kind.');
        if (u.pathname === '/mcp') return send(res, 200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'bench.list_kinds', inputSchema: { type: 'object' } }] } });
        const responses = {
            '/api/v1/kinds': { count: 1, kinds: [{ id: 'vision' }] },
            '/api/v1/kinds/vision': { kind: { id: 'vision' } },
            '/api/v1/kinds/vision/tasks': { task: { id: 't1' } },
            '/api/v1/tasks/t1': { task: { id: 't1' } },
            '/api/v1/tasks/t1/rounds': { round: { id: 'r1' } },
            '/api/v1/rounds/r1': { round: { id: 'r1' } },
            '/api/v1/rounds/r1/entries': { entry: { id: 'e1' } },
            '/api/v1/judgements/next': { pair: null, detail: 'No round' },
            '/api/v1/rounds/r1/judgements': { judgement: { id: 'j1' } },
            '/api/v1/boards/vision': { board: { type: 'pareto', rows: [] } },
            '/api/v1/models/model%2Fone': { model: 'model/one', ratings: [], entries: [], total_cost_usd: 0 },
            '/api/v1/evals': { eval: { id: 'v1' } },
            '/api/v1/evals/v1': { eval: { id: 'v1' } },
            '/api/v1/evals/v1/run': { run: { id: 'run1' } },
            '/api/v1/evals/v1/results': { eval: { id: 'v1' }, runs: [] },
        };
        if (Object.hasOwn(responses, u.pathname)) return send(res, req.method === 'POST' ? 201 : 200, responses[u.pathname]);
        return problem(res, 404, 'bench.not_found', 'Missing');
    });
}

run([
    ['all JSON routes preserve Bench envelopes, paths, query and bodies', async () => {
        const srv = await bench();
        try {
            const b = createBenchClient(createClient({ baseUrls: { bench: srv.url }, retries: 0 }));
            assert.equal((await b.kinds.list()).count, 1);
            assert.equal((await b.kinds.get('vision')).kind.id, 'vision');
            assert.equal((await b.tasks.create('vision', { prompt: 'Compare', task_class: 'image', public: true })).task.id, 't1');
            assert.equal((await b.tasks.get('t1')).task.id, 't1');
            assert.equal((await b.rounds.create('t1', { offers: [{ provider: 'ai', model: 'one' }], seed: 7 })).round.id, 'r1');
            assert.equal((await b.rounds.get('r1')).round.id, 'r1');
            assert.equal((await b.entries.submit('r1', { provider: 'ai', model: 'one', payload: { text: 'hello' }, cost_usd: 0.01 })).entry.id, 'e1');
            assert.equal((await b.judgements.next({ kind: 'vision' })).pair, null);
            assert.equal((await b.judgements.cast('r1', { judge: 'human_pairwise', pair: { left: 'e1', right: 'e2' }, outcome: 'left' })).judgement.id, 'j1');
            assert.equal((await b.boards.get('vision', { type: 'pareto', category: 'all', period: 'month' })).board.type, 'pareto');
            assert.equal((await b.models.get('model/one')).model, 'model/one');
            assert.equal((await b.evals.create({ kind_id: 'vision', name: 'Private', test_suite: [{ prompt: 'x' }] })).eval.id, 'v1');
            assert.equal((await b.evals.get('v1')).eval.id, 'v1');
            assert.equal((await b.evals.run('v1', { offers: [{ provider: 'ai' }] })).run.id, 'run1');
            assert.deepEqual((await b.evals.results('v1')).runs, []);
            assert.deepEqual(srv.requests.map((r) => [r.method, r.url]), [
                ['GET', '/api/v1/kinds'], ['GET', '/api/v1/kinds/vision'],
                ['POST', '/api/v1/kinds/vision/tasks'], ['GET', '/api/v1/tasks/t1'],
                ['POST', '/api/v1/tasks/t1/rounds'], ['GET', '/api/v1/rounds/r1'],
                ['POST', '/api/v1/rounds/r1/entries'], ['GET', '/api/v1/judgements/next?kind=vision'],
                ['POST', '/api/v1/rounds/r1/judgements'], ['GET', '/api/v1/boards/vision?type=pareto&category=all&period=month'],
                ['GET', '/api/v1/models/model%2Fone'], ['POST', '/api/v1/evals'],
                ['GET', '/api/v1/evals/v1'], ['POST', '/api/v1/evals/v1/run'], ['GET', '/api/v1/evals/v1/results'],
            ]);
            assert.deepEqual(JSON.parse(srv.requests[2].body), { prompt: 'Compare', task_class: 'image', public: true });
            assert.deepEqual(JSON.parse(srv.requests[4].body), { offers: [{ provider: 'ai', model: 'one' }], seed: 7 });
            assert.deepEqual(JSON.parse(srv.requests[6].body), { provider: 'ai', model: 'one', payload: { text: 'hello' }, cost_usd: 0.01 });
            assert.deepEqual(JSON.parse(srv.requests[8].body), { judge: 'human_pairwise', pair: { left: 'e1', right: 'e2' }, outcome: 'left' });
        } finally { await srv.close(); }
    }],
    ['dataset text and streamed lines; MCP tools list; service audience and acting subject', async () => {
        const srv = await bench();
        try {
            const b = createBenchClient(createClient({ baseUrls: { bench: srv.url }, getToken: ({ audience }) => `svc-${audience}` }), { actingSubject: USR });
            assert.match(await b.datasets.get('vision'), /"type":"task"/);
            const lines = [];
            await b.datasets.iterate('vision', async (line) => { lines.push(line); });
            assert.deepEqual(lines, [{ type: 'task', id: 't1' }, { type: 'round', id: 'r1' }]);
            assert.equal((await b.mcpTools())[0].name, 'bench.list_kinds');
            assert.deepEqual(JSON.parse(srv.requests[2].body), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
            assert.equal(srv.requests[0].headers.authorization, 'Bearer svc-openvibe.bench');
            assert.equal(srv.requests[0].headers['x-ov-subject'], USR);
            assert.equal(srv.requests[2].headers['x-ov-subject'], USR);
        } finally { await srv.close(); }
    }],
    ['problem errors are OpenVibeError; invalid acting subjects fail before the request', async () => {
        const srv = await bench();
        try {
            const b = createBenchClient(createClient({ baseUrls: { bench: srv.url }, retries: 0 }));
            await assert.rejects(b.kinds.get('missing'), (err) => err instanceof OpenVibeError && err.code === 'bench.kind_not_found' && err.status === 404);
            assert.throws(() => b.kinds.list({ actingSubject: 'bad' }), /actingSubject/);
            assert.equal(srv.requests.length, 1);
        } finally { await srv.close(); }
    }],
]);
