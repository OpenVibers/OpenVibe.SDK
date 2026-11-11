'use strict';
const assert = require('assert');
const { createAgentSheetClient } = require('../src/agent-sheet');
const { createActorClient } = require('../src/actor');
const seen = [];
const client = createAgentSheetClient({ json: async (request) => { seen.push(request); return { ok: true }; } });
const agent = 'agt_00000000000000000000000000';
const memory = 'mem_00000000000000000000000000';

(async () => {
    await client.sheet(agent);
    await client.codesSheet('codex');
    await client.pause(agent);
    await client.resume(agent);
    await client.memory.add(agent, 'A fact');
    await client.memory.update(agent, memory, 'New fact');
    await client.memory.remove(agent, memory);
    await createActorClient({ json: async (request) => { seen.push(request); return { ok: true }; }, request: async () => ({}) }).me.agents.sheet(agent);
    assert.deepStrictEqual(seen.map((r) => [r.method || 'GET', r.path]), [
        ['GET', `/api/frame/agents/${agent}/sheet`],
        ['GET', '/api/frame/codes-agents/codex/sheet'],
        ['PATCH', `/api/frame/agents/${agent}`],
        ['PATCH', `/api/frame/agents/${agent}`],
        ['POST', `/api/frame/agents/${agent}/memory`],
        ['PATCH', `/api/frame/agents/${agent}/memory/${memory}`],
        ['DELETE', `/api/frame/agents/${agent}/memory/${memory}`],
        ['GET', `/api/v1/me/agents/${agent}`],
    ]);
    assert.ok(seen.slice(0, -1).every((r) => r.service === 'network' && r.audience === 'openvibe.network'));
    assert.deepStrictEqual(seen.at(-1).query, { view: 'sheet' });
    assert.deepStrictEqual([seen[2].json, seen[3].json], [{ status: 'paused' }, { status: 'active' }]);
    assert.throws(() => client.sheet('../other'), TypeError);
    assert.throws(() => client.codesSheet('../other'), TypeError);
    assert.throws(() => client.memory.remove(agent, '../other'), TypeError);
    console.log('agent sheet reader: fixed Network paths and validated IDs');
})().catch((error) => { console.error(error); process.exitCode = 1; });
