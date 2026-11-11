'use strict';

const assert = require('node:assert/strict');
const { createCodesClient } = require('../src/codes');

(async () => {
    const calls = [];
    const client = { json: async (options) => { calls.push(options); return options; } };
    const ov = createCodesClient(client, { actingSubject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1' });
    const plan = { mode: 'single', roles: [{ role: 'builder', model: 'auto', effort: 'low' }], checks: { tests: true } };
    await ov.modelPlans.get();
    await ov.modelPlans.get({ project: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1' });
    await ov.modelPlans.put(plan);
    await ov.modelPlans.presets();
    await ov.tasks.create({ repo: 'https://github.com/a/b', prompt: 'Fix a bug', preset: 'Fast', idempotency_key: 'task:1' });
    await ov.tasks.create({ repo: 'https://github.com/a/b', prompt: 'Fix a bug', plan });
    assert.deepEqual(calls.map((call) => [call.method || 'GET', call.path]), [
        ['GET', '/api/v1/model-plans'], ['GET', '/api/v1/model-plans'], ['PUT', '/api/v1/model-plans'],
        ['GET', '/api/v1/model-plans/presets'], ['POST', '/api/v1/tasks'], ['POST', '/api/v1/tasks'],
    ]);
    assert.equal(calls[1].query.project, 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1');
    assert.deepEqual(calls[2].json, { plan });
    assert.equal(calls[3].auth, false);
    assert.equal(calls[4].idempotent, true);
    assert.equal(calls[5].idempotencyKey, false);
    assert.equal(calls[4].headers['X-OV-Subject'], 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1');
    assert.throws(() => ov.tasks.create({ repo: 'https://github.com/a/b', prompt: 'x', plan, preset: 'Fast' }), /choose a plan or preset/);
    const esm = await import('../esm/codes.mjs');
    assert.equal(typeof esm.createCodesClient, 'function');
    const packageEntry = await import('openvibe-sdk/codes');
    assert.equal(typeof packageEntry.createCodesClient, 'function');
    console.log('codes SDK: model plan API, task options and exports');
})().catch((error) => { console.error(error); process.exitCode = 1; });
