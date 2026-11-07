'use strict';
// openvibe-sdk/actor: the agent contacts and approval levels (plan §12 A-1) through a real core client against a local
// stub, plus the public catalog's explicit /api/v1/agent-systems path (a person's /api/v1/agents is their contacts).
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createActorClient } = require('../src/actor');

const AGENT = 'agt_01M4C49CW34NGX7TR2TNRVFWNW';
const agent = (over = {}) => ({
    id: AGENT, owner: 'user:usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', name: 'Vibe', face: 'preset:vibe', voice: null,
    model: { engine: 'runtime', model: 'smart' }, computer: null, apps: [], memory: null, level: 'ask',
    created_at: '2026-11-07T09:30:00.000Z', ...over,
});

(async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/v1/agent-systems') return json(200, { agents: [{ id: 'openvibe-runtime' }] });
            if (req.url === '/api/v1/agents/presets') return json(200, { presets: [{ id: 'researcher', name: 'Researcher' }] });
            if (req.url === '/api/v1/agents' && req.method === 'GET') return json(200, { agents: [agent()] });
            if (req.url === '/api/v1/agents' && req.method === 'POST') return json(201, agent({ name: 'Researcher' }));
            if (req.url === `/api/v1/agents/${AGENT}/level` && req.method === 'PUT') return json(200, agent({ level: 'auto-edits' }));
            if (req.url === `/api/v1/agents/${AGENT}` && req.method === 'PATCH') return json(200, agent({ name: 'Vibe 2' }));
            if (req.url === `/api/v1/agents/${AGENT}` && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
            if (req.url === `/api/v1/agents/${AGENT}` && req.method === 'GET') return json(200, agent());
            return json(404, { code: 'actor.agent.not_found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const actor = createActorClient(createClient({ baseUrls: { actor: base }, token: 'person-token' }));
    try {
        assert.deepStrictEqual(await actor.contacts.list(), { agents: [agent()] });
        assert.deepStrictEqual(await actor.contacts.presets(), { presets: [{ id: 'researcher', name: 'Researcher' }] });
        assert.deepStrictEqual(await actor.contacts.get(AGENT), agent());
        const created = await actor.contacts.create({ preset: 'researcher', name: 'Researcher' });
        assert.strictEqual(created.name, 'Researcher');
        assert.deepStrictEqual(await actor.contacts.update(AGENT, { name: 'Vibe 2' }), agent({ name: 'Vibe 2' }));
        assert.deepStrictEqual(await actor.contacts.setLevel(AGENT, 'auto-edits'), agent({ level: 'auto-edits' }));
        await actor.contacts.remove(AGENT);
        assert.deepStrictEqual(await actor.agents.catalog(), { agents: [{ id: 'openvibe-runtime' }] });
        assert.deepStrictEqual(await actor.agents.list(), { agents: [{ id: 'openvibe-runtime' }] });

        assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
            'GET /api/v1/agents', 'GET /api/v1/agents/presets', `GET /api/v1/agents/${AGENT}`,
            'POST /api/v1/agents', `PATCH /api/v1/agents/${AGENT}`, `PUT /api/v1/agents/${AGENT}/level`,
            `DELETE /api/v1/agents/${AGENT}`, 'GET /api/v1/agent-systems', 'GET /api/v1/agent-systems',
        ]);
        assert.ok(seen.every((s) => s.auth === 'Bearer person-token'), 'the person token rides every call');
        assert.strictEqual(JSON.parse(seen[3].body).preset, 'researcher');
        assert.deepStrictEqual(JSON.parse(seen[5].body), { level: 'auto-edits' });
        assert.throws(() => actor.contacts.get('nope'), /agent id/);
        console.log('  ok  actor contacts: list, presets, create, update, level, delete and the explicit catalog');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
