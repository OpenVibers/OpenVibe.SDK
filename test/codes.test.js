'use strict';
// openvibe-sdk/codes: the Dock's Code tab calls (list, create, stop) through a real core client against a local stub.
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createCodesClient } = require('../src/codes');

const TASK = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const summary = (over = {}) => ({
    id: TASK, title: 'Add a test', status: 'running', mode: 'repo', repo: 'https://github.com/octocat/Hello-World',
    started_at: '2026-11-10T10:00:00.000Z', updated_at: '2026-11-10T10:04:00.000Z', steps: 2,
    url: `https://openvibe.codes/tasks/${TASK}`, preview_url: null, pr_url: null, ...over,
});

(async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/v1/me/tasks?limit=8' && req.method === 'GET') return json(200, { tasks: [summary()] });
            if (req.url === '/api/v1/model-plans/presets' && req.method === 'GET') return json(200, { presets: { Fast: { mode: 'single' } } });
            if (req.url.startsWith('/api/v1/model-plans') && req.method === 'GET') return json(200, { account: { mode: 'pair' }, effective: { mode: 'pair' } });
            if (req.url.startsWith('/api/v1/model-plans') && req.method === 'PUT') return json(200, { resolved: JSON.parse(body).plan });
            if (req.url === '/api/v1/tasks' && req.method === 'POST') {
                const b = JSON.parse(body);
                if (b.mode === 'create') return json(200, { id: null, url: 'https://openvibe.space/auth/login?next=%2Fspaces%2Fnew' });
                return json(201, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
            }
            if (req.url === `/api/v1/tasks/${TASK}/stop` && req.method === 'POST') return json(200, { ok: true });
            if (req.url === '/api/v1/me/usage' && req.method === 'GET') return json(200, { agents: [{ agent: 'codex', name: 'Codex', state: 'ok', windows: [{ name: 'week', used_pct: 30, resets_at: '2026-11-25T07:00:00Z' }], take: false, why: 'its next reset is in 80 h' }], spare: { enabled: true, queued: 1 } });
            if (req.url === '/api/v1/me/spare' && req.method === 'PUT') return json(200, { settings: { enabled: JSON.parse(body).enabled } });
            if (req.url === '/api/v1/me/spare/tasks' && req.method === 'POST') return json(201, { task: { id: 'spt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', ...JSON.parse(body) } });
            if (req.url === '/api/v1/me/spare/loops' && req.method === 'GET') return json(200, { loops: [{ id: 'accessibility', name: 'Accessibility', what: 'WCAG 2.2 AA' }] });
            if (req.url === '/api/v1/me/spare/tasks/spt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' && req.method === 'PATCH') return json(200, { task: { state: JSON.parse(body).state } });
            if (req.url === '/api/v1/me/spare/tasks/spt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
            return json(404, { code: 'codes.task_not_found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const codes = createCodesClient(createClient({ baseUrls: { codes: base }, token: 'person-token' }));
    try {
        // Spare usage (plan §AD.37): the agents' windows, the list's settings, and its tasks.
        const usage = await codes.usage();
        assert.strictEqual(usage.agents[0].windows[0].used_pct, 30);
        assert.strictEqual((await codes.spare.settings({ enabled: true })).settings.enabled, true);
        const added = await codes.spare.add({ prompt: 'Add tests for fleet.js', repo: 'OpenVibers/OpenVibe.Codes' });
        assert.strictEqual(added.task.id, 'spt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3');
        assert.strictEqual((await codes.spare.update(added.task.id, { state: 'paused' })).task.state, 'paused');
        await codes.spare.remove(added.task.id);
        assert.throws(() => codes.spare.add({ prompt: 'x' }), /repo is owner\/name/);
        const looped = await codes.spare.add({ loop: 'accessibility', repo: 'OpenVibers/OpenVibe.Live', site: 'https://openvibe.live' });
        assert.strictEqual(looped.task.loop, 'accessibility', 'a loop is sent as such');
        assert.deepStrictEqual((await codes.spare.loops()).loops.map((l) => l.id), ['accessibility']);
        assert.throws(() => codes.spare.update('tsk_x', {}), /spt_/);
        assert.ok(seen.filter((x) => x.url.startsWith('/api/v1/me/')).every((x) => x.auth === 'Bearer person-token'), 'the person token rides every call');
        seen.length = 0;
        const listed = await codes.tasks.list({ limit: 8 });
        assert.deepStrictEqual(listed, { tasks: [summary()] });
        const created = await codes.tasks.create({ text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' });
        assert.deepStrictEqual(created, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
        const space = await codes.tasks.create({ text: 'A bakery site.', mode: 'create' });
        assert.strictEqual(space.id, null);
        assert.ok(space.url.startsWith('https://openvibe.space'));
        assert.deepStrictEqual(await codes.tasks.stop(TASK), { ok: true });
        const plan = { mode: 'single', roles: [{ role: 'builder', model: 'auto', effort: 'low' }], checks: { tests: true, lint: false, reviewer: false } };
        assert.equal((await codes.modelPlans.get()).effective.mode, 'pair');
        assert.equal((await codes.modelPlans.get({ project: 'prj_example' })).account.mode, 'pair');
        assert.deepStrictEqual(await codes.modelPlans.put(plan, { project: 'prj_example' }), { resolved: plan });
        assert.equal((await codes.modelPlans.presets()).presets.Fast.mode, 'single');
        await codes.tasks.create({ text: 'Use a preset', mode: 'repo', preset: 'Deep' });
        await codes.tasks.create({ text: 'Use a plan', mode: 'repo', plan });
        assert.equal(JSON.parse(seen.find((s) => s.url === '/api/v1/tasks' && JSON.parse(s.body).preset === 'Deep').body).preset, 'Deep');
        assert.deepStrictEqual(JSON.parse(seen.find((s) => s.url === '/api/v1/tasks' && JSON.parse(s.body).plan).body).plan, plan);
        assert.deepStrictEqual(JSON.parse(seen.find((s) => s.url === '/api/v1/model-plans?project=prj_example' && s.method === 'PUT').body), { plan });

        const posted = JSON.parse(seen.find((s) => s.url === '/api/v1/tasks' && JSON.parse(s.body).mode === 'repo').body);
        assert.deepStrictEqual(posted, { text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' });
        assert.ok(seen.every((s) => s.auth === 'Bearer ' + 'person-token'), 'the person token rides every call');
        assert.throws(() => codes.tasks.list({ limit: 0 }), /limit is 1-50/);
        assert.throws(() => codes.tasks.create({ text: '', mode: 'repo' }), /text is the instruction/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'teleport' }), /mode is create/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', repo: '  ' }), /repo is a repository/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', attachments: [42] }), /attachment ids/);
        assert.throws(() => codes.tasks.stop('nope'), /tsk_/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', plan, preset: 'Fast' }), /choose plan or preset/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', preset: 'Unknown' }), /preset is Fast/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'create', preset: 'Fast' }), /coding tasks/);
        assert.throws(() => codes.modelPlans.put(null), /plan is a model plan/);
        console.log('  ok  codes tasks: list, create (repo and create), stop, and every validation');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
