'use strict';
// openvibe-sdk/agents/api: the Run API from a store, on a real Node http server, read back with the SDK's own client.
const assert = require('node:assert/strict');
const http = require('node:http');
const { run } = require('./helpers');
const { createRunApi } = require('../src/agents/api');
const { createClient } = require('../src/core');
const { createAgentsClient } = require('../src/agents');

/** A memory store: Ada's runs; a chat that answers a moment after each message. */
function memoryStore() {
    const runs = new Map(); const steps = new Map(); const seen = { starts: [], answers: [] };
    let n = 0;
    const mine = (owner, id) => { const r = runs.get(id); return r && r.owner.id === owner.id ? r : null; };
    return {
        seen, runs, steps,
        async list({ owner, kind, limit }) { return { runs: [...runs.values()].filter((r) => r.owner.id === owner.id && (!kind || r.kind === kind)).slice(0, limit), next: null }; },
        async get({ owner, id }) { return mine(owner, id); },
        async steps({ owner, id, after, limit }) { if (!mine(owner, id)) return null; return { steps: (steps.get(id) || []).filter((s) => s.seq > after).slice(0, limit), next: null }; },
        async start({ owner, input, idempotencyKey }) {
            seen.starts.push({ input, idempotencyKey });
            const id = `c_${++n}`;
            const r = { id, kind: input.kind || 'chat', title: input.text.slice(0, 40), owner, status: 'waiting', waiting: { for: 'message' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            runs.set(id, r); steps.set(id, [{ run_id: id, seq: 1, kind: 'message', from: 'person', text: input.text }]);
            return r;
        },
        async say({ owner, id, text }) {
            const r = mine(owner, id); if (!r) { const e = new Error('No such run'); e.status = 404; e.code = 'runs.not_found'; throw e; }
            const list = steps.get(id); const step = { run_id: id, seq: list.length + 1, kind: 'message', from: 'person', text };
            list.push(step);
            setTimeout(() => { list.push({ run_id: id, seq: list.length + 1, kind: 'message', from: 'agent', text: `You said: ${text}` }); if (text === 'bye') r.status = 'done'; }, 80);
            return step;
        },
        async answer({ approval, answer }) { seen.answers.push([approval, answer]); return { ok: true }; },
    };
}

async function serve(api) {
    const server = http.createServer((req, res) => api.handle(req, res, () => { res.statusCode = 418; res.end('not mine'); }));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}
const ADA = { type: 'user', id: 'usr_ada' };
const subject = async (req) => (req.headers.authorization === 'Bearer ada' ? ADA : req.headers.authorization === 'Bearer bo' ? { type: 'user', id: 'usr_bo' } : null);

run([
    ['the routes, read back with the SDK client: start, list, get, say, steps, the stream to its end, approvals', async () => {
        const store = memoryStore();
        const srv = await serve(createRunApi({ store, subject, product: 'chat', prefix: '/api/v1', pollMs: 30 }));
        try {
            const agents = createAgentsClient(createClient({ baseUrls: { network: srv.url }, token: 'ada' }));
            const started = await agents.runs.start('A goal bar for my sub goal', { idempotencyKey: 'k-1' });
            assert.equal(started.ref, 'chat:c_1', 'every run carries its ref');
            assert.deepEqual(store.seen.starts[0], { input: { text: 'A goal bar for my sub goal' }, idempotencyKey: 'k-1' });
            const listed = await agents.runs.list({ kind: 'chat' });
            assert.deepEqual(listed.runs.map((r) => r.ref), ['chat:c_1']);
            assert.equal((await agents.runs.get('chat:c_1')).title, 'A goal bar for my sub goal', 'a ref works as the id');
            assert.equal(await agents.runs.get('c_9'), null, 'a run that is not there is null (404)');
            const said = await agents.runs.say('c_1', 'Make it purple');
            assert.deepEqual([said.seq, said.from], [2, 'person']);
            const got = [];
            const end = await agents.runs.follow('c_1', { onStep: (s) => { got.push(s.text); if (s.text === 'You said: Make it purple') agents.runs.say('c_1', 'bye'); } });
            assert.equal(end.status, 'done', 'follow resolves with the end status');
            assert.deepEqual(got.filter((t) => t.startsWith('You said')), ['You said: Make it purple', 'You said: bye']);
            assert.deepEqual(await agents.approvals.answer('c_1', 'apr_1', 'approve'), { ok: true });
            assert.deepEqual(store.seen.answers, [['apr_1', 'approve']]);
        } finally { await srv.close(); }
    }],
    ['who may: no subject is 401; someone else\'s run is 404; a path that is not the Run API\'s goes to next()', async () => {
        const store = memoryStore();
        const srv = await serve(createRunApi({ store, subject, product: 'chat', prefix: '/api/v1' }));
        try {
            await store.start({ owner: ADA, input: { text: 'mine' } });
            const call = (path, o = {}) => fetch(srv.url + path, { ...o, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) } });
            let r = await call('/api/v1/runs');
            assert.equal(r.status, 401); assert.equal((await r.json()).code, 'auth.required');
            r = await call('/api/v1/runs/c_1', { token: 'bo' });
            assert.equal(r.status, 404, 'Bo cannot read Ada\'s run');
            r = await call('/api/v1/runs/c_1/messages', { method: 'POST', token: 'bo', body: JSON.stringify({ text: 'hi' }) });
            assert.equal(r.status, 404, 'nor speak in it');
            r = await call('/api/v1/other', { token: 'ada' });
            assert.equal(r.status, 418, 'not the Run API\'s: next()');
            r = await call('/api/v1/runs/a%20b', { token: 'ada' });
            assert.equal(r.status, 404, 'an id that is not one');
        } finally { await srv.close(); }
    }],
    ['what is refused: no words, a kind that is not one, a bad body, an answer without one; a mandate from a caller is dropped', async () => {
        const store = memoryStore();
        const srv = await serve(createRunApi({ store, subject, product: 'actor' }));
        try {
            const post = (path, body, raw) => fetch(srv.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ada' }, body: raw || JSON.stringify(body) });
            assert.equal((await (await post('/runs', { text: '  ' })).json()).code, 'runs.start_needs_words');
            assert.equal((await (await post('/runs', { text: 'x', kind: 'wish' })).json()).code, 'runs.bad_kind');
            assert.equal((await post('/runs', null, '{nope')).status, 400);
            const r = await post('/runs', { text: 'Post the clip', kind: 'task', mandate: { source: 'feed', asked_by: { type: 'user', id: 'usr_someone' }, strength: 'explicit' } });
            assert.equal(r.status, 201);
            assert.equal('mandate' in store.seen.starts[0].input, false, 'only intake sets a mandate');
            assert.equal((await post('/runs/c_1/approvals/apr_1', {})).status, 422);
            assert.equal((await post('/runs/c_1/approvals/bad%2Fid', { answer: 'yes' })).status, 404);
        } finally { await srv.close(); }
    }],
    ['a store without a method says so (409); a store\'s own error goes out as it is; anything else says nothing of the store', async () => {
        const failing = { async list() { throw new Error('the database password is hunter2'); }, async get() { const e = new Error('Paused by the owner'); e.status = 423; e.code = 'runs.paused'; throw e; } };
        const srv = await serve(createRunApi({ store: failing, subject, product: 'codes' }));
        try {
            const get = (p) => fetch(srv.url + p, { headers: { authorization: 'Bearer ada' } });
            let r = await get('/runs');
            assert.equal(r.status, 500);
            const body = await r.json();
            assert.equal(body.error, 'Runs are unavailable right now');
            assert.ok(!JSON.stringify(body).includes('hunter2'), 'no store detail leaks');
            r = await get('/runs/tsk_1');
            assert.deepEqual([r.status, (await r.json()).code], [423, 'runs.paused']);
            r = await fetch(srv.url + '/runs/tsk_1/messages', { method: 'POST', headers: { authorization: 'Bearer ada', 'content-type': 'application/json' }, body: '{"text":"hi"}' });
            assert.deepEqual([r.status, (await r.json()).code], [409, 'runs.cannot_say']);
        } finally { await srv.close(); }
    }],
    ['a store that pushes its own events is used for the stream, with refs on runs', async () => {
        const store = { ...memoryStore(), async follow({ emit }) { emit('step', { step: { seq: 2, kind: 'message', text: 'hi' } }, 2); emit('run', { run: { id: 'c_1', status: 'done' } }, 2); emit('end', { status: 'done' }, 2); } };
        await store.start({ owner: ADA, input: { text: 'x' } });
        const srv = await serve(createRunApi({ store, subject, product: 'chat' }));
        try {
            const r = await fetch(srv.url + '/runs/c_1/events', { headers: { authorization: 'Bearer ada', 'last-event-id': '1' } });
            const text = await r.text();
            assert.match(text, /id: 2\nevent: step\ndata: \{"type":"step","step":\{"seq":2/);
            assert.match(text, /"run":\{"id":"c_1","status":"done","ref":"chat:c_1"\}/);
            assert.match(text, /event: end/);
            const bad = await fetch(srv.url + '/runs/c_1/events', { headers: { authorization: 'Bearer ada', 'last-event-id': 'x' } });
            assert.equal(bad.status, 400);
        } finally { await srv.close(); }
    }],
    ['a store and a subject are required', () => {
        assert.throws(() => createRunApi({ subject, product: 'chat' }), /a store is required/);
        assert.throws(() => createRunApi({ store: {}, product: 'chat' }), /subject\(req\) is required/);
        assert.throws(() => createRunApi({ store: {}, subject, product: 'Chat!' }), /product is a short lowercase name/);
    }],
]);
