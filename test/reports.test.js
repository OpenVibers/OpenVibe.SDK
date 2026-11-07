'use strict';
// openvibe-sdk/reports: a session report from any harness with the person's token (Agent Streams S3/S7). The write
// is private unless the caller names an audience, carries no owner (the Report service decides it from the token),
// and is idempotent per source and task ref through its key.
const assert = require('assert');
const { createClient } = require('../src/core');
const { createReportsClient, cleanReport } = require('../src/reports');
const { stubServer, send, run } = require('./helpers');

(async () => {
    const server = await stubServer(async (req, res, body) => {
        const path = req.url.split('?')[0];
        if (req.method === 'POST' && path === '/api/v1/me/session-reports') {
            return send(res, 201, { id: 'rps_01JAB2C3D4E5F6G7H8J9K0MNPS', url: 'https://openvibe.report/s/rps_01JAB2C3D4E5F6G7H8J9K0MNPS', created: true });
        }
        if (req.method === 'GET' && path === '/api/v1/session-reports/rps_01JAB2C3D4E5F6G7H8J9K0MNPS') {
            return send(res, 200, { id: 'rps_01JAB2C3D4E5F6G7H8J9K0MNPS', task: { title: 'Fix the login page' } });
        }
        return send(res, 404, { error: 'not found' });
    });
    const client = createClient({ baseUrls: { report: server.url }, token: 'person-token', retries: 0 });
    const reports = createReportsClient(client);
    const last = () => server.requests[server.requests.length - 1];

    await run([
        ['write posts the report with the person\'s token and no owner', async () => {
            const out = await reports.write({
                source: 'node', task: { ref: 'run_123', title: 'Fix the login page' },
                summary: 'The login page redirects again; the tests are green.', outcome: 'done',
                worked_seconds: 912, cost_usd: 0.42,
            });
            assert.strictEqual(last().method, 'POST');
            assert.strictEqual(last().url, '/api/v1/me/session-reports');
            assert.strictEqual(last().headers.authorization, 'Bearer person-token');
            const body = JSON.parse(String(last().body));
            assert.deepStrictEqual(body.task, { ref: 'run_123', title: 'Fix the login page' });
            assert.strictEqual(body.summary, 'The login page redirects again; the tests are green.');
            assert.strictEqual(body.outcome, 'done');
            assert.strictEqual(body.visibility, undefined, 'private is the service default, not a guess here');
            assert.strictEqual(body.owner, undefined, 'the Report service takes the owner from the token');
            assert.ok(last().headers['idempotency-key'].startsWith('report:node:run_123'), 'idempotent per source and task');
            assert.strictEqual(out.id, 'rps_01JAB2C3D4E5F6G7H8J9K0MNPS');
            assert.ok(out.url.endsWith(out.id));
        }],

        ['a public report names its audience, and the timeline is clean', async () => {
            await reports.write({
                source: 'codes', task: { ref: 'tsk_2', title: 'A public run' }, summary: 'Two steps.',
                visibility: 'public', timeline: [{ title: 'Run the tests', status: 'started' }, { title: 'Run the tests', status: 'passed', tests: { passed: 3, failed: 0 } }],
            });
            const body = JSON.parse(String(last().body));
            assert.strictEqual(body.visibility, 'public');
            assert.deepStrictEqual(body.timeline.map((s) => s.status), ['started', 'passed']);
        }],

        ['the guards run before anything leaves', async () => {
            const before = server.requests.length;
            await assert.rejects(() => reports.write({ source: 'browser', task: { ref: 'a', title: 'b' }, summary: 'x' }), /source/);
            await assert.rejects(() => reports.write({ source: 'node', task: { ref: 'a', title: 'b' } }), /summary/);
            await assert.rejects(() => reports.write({ source: 'node', task: { ref: 'a', title: 'b' }, summary: 'x', outcome: 'maybe' }), /outcome/);
            await assert.rejects(() => reports.write({ source: 'node', task: { ref: 'a', title: 'b' }, summary: 'x', visibility: 'everyone' }), /visibility/);
            await assert.rejects(() => reports.read('not-a-report'), /report id/);
            assert.strictEqual(server.requests.length, before, 'nothing was sent');
        }],

        ['read gets one report the caller may see', async () => {
            const r = await reports.read('rps_01JAB2C3D4E5F6G7H8J9K0MNPS');
            assert.deepStrictEqual([last().method, last().url], ['GET', '/api/v1/session-reports/rps_01JAB2C3D4E5F6G7H8J9K0MNPS']);
            assert.strictEqual(r.task.title, 'Fix the login page');
        }],

        ['cleanReport is the body the service sees, with a raw transcript never in it', async () => {
            const body = cleanReport({ source: 'node', task: { ref: 'a', title: 'b' }, summary: 's', transcript: 'the raw words' });
            assert.ok(!('transcript' in body), 'a harness cannot smuggle the raw transcript into a report');
        }],
    ]);

    await server.close();
    console.log('openvibe-sdk/reports: the write with the person\'s token, private by default, and the guards');
})().catch((e) => { console.error(e); process.exit(1); });
