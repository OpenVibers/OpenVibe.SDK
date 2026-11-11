'use strict';
const assert = require('node:assert/strict');
const { createToolsClient } = require('../src/tools');
(async () => {
    const requests = [];
    const execution = { worker: 'host', location: 'host', took_ms: 12, attempts: [{ worker: 'host', location: 'host', took_ms: 12, state: 'succeeded' }] };
    const id = 'job_01K5WZX7S7Q4D2B8N3M6V1C9TR';
    const tools = createToolsClient({ options: {}, async request(opts) {
        requests.push(opts);
        const body = opts.path.startsWith('/api/v1/jobs/') ? { id, state: 'succeeded', result: { data: { execution } } } : { state: 'succeeded', tool: 'png', took_ms: 12, result: { data: { execution } } };
        return { data: body, status: 200, headers: new Headers({ 'content-type': 'application/json' }) };
    } });
    const first = await tools.run('png', {}, { prefer: 'host' });
    assert.equal(requests[0].headers['X-Tools-Prefer'], 'host');
    assert.deepEqual(requests[0].json, { input: {} }, 'preference is a header, preserving the request contract');
    assert.deepEqual(first.result.data.execution, execution);
    await tools.run('png', {}, { prefer: 'home', files: [{ name: 'a.png', data: new Uint8Array([1, 2]), type: 'image/png' }] });
    assert.equal(requests[1].headers['X-Tools-Prefer'], 'home'); assert(requests[1].form instanceof FormData);
    await tools.run('png', {}); assert.equal(requests[2].headers, undefined);
    await assert.rejects(tools.run('png', {}, { prefer: 'somewhere' }), TypeError);
    const job = await tools.jobs.get(id);
    assert.equal(requests.at(-1).path, `/api/v1/jobs/${id}`);
    assert.deepEqual(job.result.data.execution, execution);
    console.log('tools routing: JSON/multipart preferences, validation, default and jobs.get receipts passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
