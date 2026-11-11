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
            if (req.url === '/api/v1/tasks' && req.method === 'POST') {
                const b = JSON.parse(body);
                if (b.mode === 'create') return json(200, { id: null, url: 'https://openvibe.space/auth/login?next=%2Fspaces%2Fnew' });
                return json(201, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
            }
            if (req.url === `/api/v1/tasks/${TASK}/stop` && req.method === 'POST') return json(200, { ok: true });
            return json(404, { code: 'codes.task_not_found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const codes = createCodesClient(createClient({ baseUrls: { codes: base }, token: 'person-token' }));
    try {
        const listed = await codes.tasks.list({ limit: 8 });
        assert.deepStrictEqual(listed, { tasks: [summary()] });
        const created = await codes.tasks.create({ text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' });
        assert.deepStrictEqual(created, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
        const space = await codes.tasks.create({ text: 'A bakery site.', mode: 'create' });
        assert.strictEqual(space.id, null);
        assert.ok(space.url.startsWith('https://openvibe.space'));
        assert.deepStrictEqual(await codes.tasks.stop(TASK), { ok: true });

        const posted = JSON.parse(seen.find((s) => s.url === '/api/v1/tasks' && JSON.parse(s.body).mode === 'repo').body);
        assert.deepStrictEqual(posted, { text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' });
        assert.ok(seen.every((s) => s.auth === 'Bearer ' + 'person-token'), 'the person token rides every call');
        assert.throws(() => codes.tasks.list({ limit: 0 }), /limit is 1-50/);
        assert.throws(() => codes.tasks.create({ text: '', mode: 'repo' }), /text is the instruction/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'teleport' }), /mode is create/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', repo: '  ' }), /repo is a repository/);
        assert.throws(() => codes.tasks.create({ text: 'Hi', mode: 'repo', attachments: [42] }), /attachment ids/);
        assert.throws(() => codes.tasks.stop('nope'), /tsk_/);
        console.log('  ok  codes tasks: list, create (repo and create), stop, and every validation');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
