'use strict';
// The S7 example streams a stub agent's steps end to end (design §8): the example starts the stream, posts the
// command's output as steps, ends the stream, and every request the SDK made is what Live's routes expect.
const assert = require('assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { stubServer, send } = require('./helpers');

const AGS = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPS';
const TICKET = 'wpt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

(async () => {
    const server = await stubServer(async (req, res, body) => {
        const u = req.url.split('?')[0];
        if (req.method === 'POST' && u === '/api/streams/agent') {
            return send(res, 201, {
                stream: { id: AGS, page_url: 'https://openvibe.live/@mira/agents/' + AGS, state: 'idle' },
                publish: { whip_url: 'https://whip.openvibe.live/whip/agent/' + AGS, ticket: TICKET, expires_at: '2026-11-07T20:00:00.000Z' },
            });
        }
        if (req.method === 'POST' && u === `/api/streams/agent/${AGS}/steps`) return send(res, 201, { step: { id: 1, ...JSON.parse(String(body)) } });
        if (req.method === 'POST' && u === `/api/streams/agent/${AGS}/end`) return send(res, 200, { stream: { id: AGS, state: 'ended' } });
        return send(res, 404, { error: 'not found' });
    });
    const child = spawn(process.execPath, [path.join(__dirname, '../examples/cli-agent-stream.js'), '--title', 'A stub agent', '--', process.execPath, '-e', "process.stdout.write('installed the packages\\nran the tests\\n')"], {
        env: { ...process.env, OPENVIBE_TOKEN: 'person-token', OPENVIBE_LIVE_URL: server.url },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { out += String(b); });
    const code = await new Promise((ok) => child.on('close', ok));
    assert.strictEqual(code, 0, out);
    const paths = server.requests.map((r) => `${r.method} ${r.url.split('?')[0]}`);
    assert.ok(paths.includes('POST /api/streams/agent'), paths.join('\n'));
    assert.ok(paths.filter((p) => p.endsWith('/steps')).length >= 3, 'the start, the command output and the result are steps');
    assert.ok(paths.includes(`POST /api/streams/agent/${AGS}/end`), 'the stream ends with the command');
    const steps = server.requests.filter((r) => r.url.endsWith('/steps')).map((r) => JSON.parse(String(r.body)));
    assert.ok(steps.some((s) => s.title === 'Started the command' && s.status === 'started'));
    assert.ok(steps.some((s) => s.status === 'passed' && s.tests && s.tests.passed === 1), 'the last step says the command passed');
    assert.match(out, /Live: https:\/\/openvibe\.live\/@mira\/agents\//);
    assert.match(out, /Ended:/);
    await server.close();
    console.log('the S7 example: a stub agent streams its steps end to end');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
