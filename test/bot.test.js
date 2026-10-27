'use strict';
/**
 * openvibe-sdk/bot: the acting header, robots/operators/devices/streaming/commands/audit, the
 * public kits and profiles, pairing, and the Contracts fixtures the requests and answers follow.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createBotClient, actingHeaders } = require('../src/bot');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const GST = 'gst_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ROB = 'rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X';
const DEV = 'dev_01J8Z4N0A1B2C3D4E5F6G7H8J9';

const FIX = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture case skips */ }
const loadFixture = (dir, file) => JSON.parse(fs.readFileSync(path.join(FIX, dir, 'valid', file), 'utf8'));

const seenCommands = [];

/** A stub Bot: fixtures for the contract-shaped answers, plus the routes the SDK turns into calls. */
function server() {
    return stubServer((req, res, body) => {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        const m = req.method;
        const fixture = (status, dir, file) => send(res, status, loadFixture(dir, file));

        if (m === 'GET' && p === `/api/v1/robots/${ROB}/audit`) {
            const before = u.searchParams.get('before');
            const limit = Number(u.searchParams.get('limit')) || 50;
            const rows = [5, 4, 3, 2, 1]
                .filter((id) => before == null || id < Number(before))
                .slice(0, limit)
                .map((id) => ({ id, kind: 'drive' }));
            return send(res, 200, { audit: rows, next_before: rows.length ? rows[rows.length - 1].id : null });
        }
        if (m === 'GET' && p === `/api/v1/robots/${ROB}/streaming`) return send(res, 200, { to: 'openre', on: false });
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/streaming`) return send(res, 200, { to: 'openre', on: true });
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/commands`) {
            const input = JSON.parse(body.toString() || '{}');
            if (input.kind === 'summon') return problem(res, 403, 'bot.not_an_operator', 'you are not an operator of this robot');
            return send(res, 200, { robot_id: ROB, result: 'ack', id: input.id });
        }
        if (m === 'POST' && p === '/api/v1/robots') return fixture(201, 'bot.robot-manage-result', 'created.json');
        if (m === 'GET' && p === '/api/v1/robots') return fixture(200, 'bot.robot-read-result', 'list.json');
        if (m === 'GET' && p === `/api/v1/robots/${ROB}`) return fixture(200, 'bot.robot-read-result', 'robot.json');
        if (m === 'GET' && p === `/api/v1/robots/${ROB}/operators`) return fixture(200, 'bot.robot-manage-result', 'operators.json');
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/operators`) return fixture(201, 'bot.robot-manage-result', 'operators.json');
        if (m === 'DELETE' && p.startsWith(`/api/v1/robots/${ROB}/operators/`)) return fixture(200, 'bot.robot-manage-result', 'operators.json');
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/pairing-code`) return send(res, 201, { code: 'K7QM-3XRT', expires_at: '2026-09-29T19:20:00.000Z', installer: 'curl …' });
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/estop`) return fixture(200, 'bot.robot-control-result', 'latched.json');
        if (m === 'POST' && p === `/api/v1/robots/${ROB}/estop/clear`) return fixture(200, 'bot.robot-control-result', 'latched.json');
        if (m === 'PATCH' && p === `/api/v1/robots/${ROB}`) return send(res, 200, { robot: loadFixture('bot.robot', 'rover.json') });
        if (m === 'DELETE' && p === `/api/v1/robots/${ROB}`) { res.writeHead(204); return res.end(); }
        if (m === 'GET' && p === `/api/v1/robots/${ROB}/devices`) return send(res, 200, { devices: [loadFixture('bot.device', 'agent.json')] });
        if (m === 'POST' && p === `/api/v1/devices/${DEV}/rotate`) return fixture(200, 'bot.device-connect-result', 'rotated.json');
        if (m === 'POST' && p === `/api/v1/devices/${DEV}/revoke`) return fixture(200, 'bot.device-connect-result', 'revoked.json');
        if (m === 'POST' && p === '/api/v1/pair') return fixture(201, 'bot.pair-result', 'paired.json');
        if (m === 'GET' && p === '/api/v1/profiles') return send(res, 200, { profiles: [loadFixture('bot.robot-profile', 'adeept-file.json')] });
        if (m === 'GET' && p === '/api/v1/profiles/adeept.adr036') return send(res, 200, { profile: loadFixture('bot.robot-profile', 'adeept-file.json') });
        if (m === 'GET' && p === '/api/v1/kits') return send(res, 200, { kits: [{ id: 'starter' }] });
        if (m === 'GET' && p === '/api/v1/kits/starter') return send(res, 200, { kit: { id: 'starter' } });
        if (m === 'GET' && p === '/api/v1/machines') return send(res, 200, { machines: [{ id: DEV, name: 'desk-host', online: true, computer: { desk: { named: true, kinds: ['browser'] } } }] });
        if (m === 'GET' && p === `/api/v1/machines/${DEV}/computer`) return send(res, 200, { machine: { id: DEV } });
        if (m === 'POST' && p === `/api/v1/machines/${DEV}/ai-models`) return send(res, 200, { machine: { id: DEV, ai_models: JSON.parse(body.toString() || '{}').on === true } });
        if (m === 'GET' && p === `/api/v1/machines/${DEV}/desk-turn`) return send(res, 200, { desk: u.searchParams.get('desk'), person_driving: false, last_person_at: null });
        if (m === 'POST' && p === `/api/v1/machines/${DEV}/commands`) {
            const input = JSON.parse(body.toString() || '{}');
            seenCommands.push(input);
            if (input.kind === 'browser' && input.value.action === 'click') return send(res, 200, { machine_id: DEV, result: 'nack', reason: 'nothing on the page matches #missing' });
            if (input.kind === 'desk') return send(res, 200, { machine_id: DEV, result: 'ack', data: { running: input.value.action === 'start', desk: input.value.desk, kind: input.value.kind || 'desktop' } });
            if (input.kind === 'ai' && input.value.model === 'busy') return send(res, 200, { machine_id: DEV, result: 'nack', reason: 'the model is answering another request on this machine' });
            if (input.kind === 'ai') return send(res, 200, { machine_id: DEV, result: 'ack', data: { model: input.value.model, message: { role: 'assistant', content: 'A lock one thread holds.' }, usage: { completion_tokens: 6 }, ms: 400 } });
            return send(res, 200, { machine_id: DEV, result: 'ack', data: { url: 'https://example.org/', title: 'Example' } });
        }
        if (p.startsWith('/api/v1/machines/')) return problem(res, 404, 'bot.device_not_found', 'no such machine of yours');
        if (p.startsWith('/api/v1/profiles/')) return problem(res, 404, 'bot.profile_not_found', 'no such profile');
        if (p.startsWith('/api/v1/kits/')) return problem(res, 404, 'bot.kit_not_found', 'no such kit');
        if (p.startsWith('/api/v1/robots/')) return problem(res, 404, 'bot.robot_not_found', 'no such robot');
        return send(res, 200, { ok: true });
    });
}

const hdr = (r, k) => r.headers[k.toLowerCase()];

run([
    ['machines and a desk of your own: start, the browser there, a nack thrown, the person\'s turn, stop', async () => {
        const srv = await server();
        try {
            const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc' }), { actingSubject: USR });
            assert.strictEqual((await bot.machines.list()).machines[0].id, DEV);
            assert.deepStrictEqual(await bot.machines.computer(DEV), { machine: { id: DEV } });
            assert.strictEqual(await bot.machines.computer('dev_01J8Z4N0A1B2C3D4E5F6G7H8J0'), null, 'an unknown machine is null');
            const desk = bot.machines.desk(DEV, { kind: 'browser', profile: 'agent' });
            assert.match(desk.name, /^desk-[a-z0-9]{10}$/);
            assert.deepStrictEqual(await desk.start(), { running: true, desk: desk.name, kind: 'browser' });
            assert.deepStrictEqual(seenCommands.at(-1), { kind: 'desk', value: { action: 'start', desk: desk.name, kind: 'browser', profile: 'agent' } });
            assert.deepStrictEqual(await desk.browser({ action: 'open', url: 'https://example.org/' }), { url: 'https://example.org/', title: 'Example' });
            assert.deepStrictEqual(seenCommands.at(-1).value, { action: 'open', url: 'https://example.org/', desk: desk.name }, 'on the desk, never the person\'s screen');
            await assert.rejects(() => desk.browser({ action: 'click', selector: '#missing' }), (e) => e.code === 'bot.desk_nack' && /nothing on the page/.test(e.message));
            assert.deepStrictEqual(await desk.turn(), { desk: desk.name, person_driving: false, last_person_at: null });
            await desk.exec({ argv: ['xterm'], detach: true });
            assert.deepStrictEqual(seenCommands.at(-1), { kind: 'exec', value: { argv: ['xterm'], detach: true, desk: desk.name } });
            assert.strictEqual((await desk.stop()).running, false);
            assert.throws(() => bot.machines.desk(DEV, { name: 'private' }), TypeError, 'only a named desk of your own');
        } finally { await srv.close(); }
    }],
    ['a machine\'s own models: one reply (kind ai), a nack thrown, the owner\'s switch', async () => {
        const srv = await server();
        try {
            const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc' }), { actingSubject: USR });
            const out = await bot.machines.chat(DEV, { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'What is a mutex?' }], max_tokens: 80 });
            assert.deepStrictEqual(out, { model: 'llama3.1:8b', message: { role: 'assistant', content: 'A lock one thread holds.' }, usage: { completion_tokens: 6 }, ms: 400 });
            assert.deepStrictEqual(seenCommands.at(-1), { kind: 'ai', value: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'What is a mutex?' }], max_tokens: 80 }, ms: 120000 });
            await assert.rejects(() => bot.machines.chat(DEV, { model: 'busy', messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'bot.ai_nack' && /another request/.test(e.message));
            await assert.rejects(() => bot.machines.chat(DEV, { model: '', messages: [] }), TypeError);
            assert.strictEqual((await bot.machines.aiModels(DEV, true)).machine.ai_models, true);
            assert.strictEqual((await bot.machines.aiModels(DEV, false)).machine.ai_models, false);
        } finally { await srv.close(); }
    }],
    ['a service acting for a person sends X-OV-Subject, its token and an Idempotency-Key', async () => {
        const srv = await server();
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc-token' }), { actingSubject: USR });
        const manage = loadFixture('bot.robot-manage-request', 'create.json');
        const created = await bot.robots.create(manage);
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/api/v1/robots');
        assert.equal(hdr(r, 'authorization'), 'Bearer svc-token');
        assert.equal(hdr(r, 'x-ov-subject'), USR);
        assert.ok(hdr(r, 'idempotency-key'), 'a mutation carries an Idempotency-Key');
        assert.equal(hdr(r, 'x-ov-origin'), undefined, 'Bot takes X-OV-Subject only, not the Community headers');
        assert.deepEqual(JSON.parse(r.body), manage, 'the manage-request fixture passes through unchanged');
        assert.deepEqual(created, loadFixture('bot.robot-manage-result', 'created.json'));
        assert.deepEqual(bot.headers(), { 'X-OV-Subject': USR });
        await srv.close();
    }],

    ['as() scopes the subject; a bare client sends none; bad subjects are refused', async () => {
        const srv = await server();
        const base = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc' }), { actingSubject: USR });
        await base.as(GST).robots.list({ owner: GST });
        assert.equal(hdr(srv.requests[0], 'x-ov-subject'), GST);
        assert.equal(srv.requests[0].url, `/api/v1/robots?owner=${GST}`);
        await base.robots.list({ owner: USR });
        assert.equal(hdr(srv.requests[1], 'x-ov-subject'), USR, 'as() did not leak into the base client');
        const plain = createBotClient(createClient({ baseUrls: { bot: srv.url } }));
        await plain.robots.list({ owner: USR });
        assert.equal(hdr(srv.requests[2], 'x-ov-subject'), undefined);
        assert.deepEqual(actingHeaders({}), {});
        assert.throws(() => actingHeaders({ actingSubject: '42' }), TypeError);
        assert.throws(() => createBotClient(createClient({ baseUrls: { bot: srv.url } }), { actingSubject: 'nope' }).headers(), TypeError);
        await srv.close();
    }],

    ['reads: list, get, null on 404, and the audit page and its iterator', async () => {
        const srv = await server();
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url } }));
        assert.deepEqual(await bot.robots.list({ owner: USR }), loadFixture('bot.robot-read-result', 'list.json'));
        assert.deepEqual(await bot.robots.get(ROB), loadFixture('bot.robot-read-result', 'robot.json'));
        assert.equal(await bot.robots.get('rob_missing'), null);
        const page = await bot.robots.audit(ROB, { limit: 2 });
        assert.deepEqual(page, { audit: [{ id: 5, kind: 'drive' }, { id: 4, kind: 'drive' }], next_before: 4 });
        const ids = [];
        for await (const entry of bot.robots.iterateAudit(ROB, { limit: 2 })) ids.push(entry.id);
        assert.deepEqual(ids, [5, 4, 3, 2, 1], 'newest first, no repeat, no extra page');
        await srv.close();
    }],

    ['commands: bot.command@1 passes through; a refusal is a typed error', async () => {
        const srv = await server();
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc' }), { actingSubject: USR });
        const drive = loadFixture('bot.command', 'drive.json');
        const ack = await bot.robots.command(ROB, drive);
        assert.deepEqual(ack, { robot_id: ROB, result: 'ack', id: 'op-7' });
        const r = srv.requests[0];
        assert.equal(r.url, `/api/v1/robots/${ROB}/commands`);
        assert.equal(hdr(r, 'x-ov-subject'), USR);
        assert.deepEqual(JSON.parse(r.body), drive, 'the command frame passes through unchanged');
        await assert.rejects(
            () => bot.robots.command(ROB, { id: 'op-8', kind: 'summon' }),
            (err) => err.status === 403 && err.code === 'bot.not_an_operator',
        );
        await srv.close();
    }],

    ['manage, control, streaming and device calls use the routes Bot serves', async () => {
        const srv = await server();
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, token: 'svc' }), { actingSubject: USR });
        await bot.robots.update(ROB, { name: 'R2' });
        assert.equal(await bot.robots.delete(ROB), null, '204 -> null');
        await bot.robots.pairingCode(ROB);
        await bot.robots.operators.add(ROB, { subject: USR, role: 'operator' });
        await bot.robots.operators.remove(ROB, USR);
        await bot.robots.devices(ROB);
        await bot.robots.estop(ROB);
        await bot.robots.clearEstop(ROB);
        await bot.robots.streaming.get(ROB);
        await bot.robots.streaming.set(ROB, { to: 'openre', on: true });
        await bot.devices.rotate(DEV);
        await bot.devices.revoke(DEV);
        const seen = srv.requests.map((r) => `${r.method} ${r.url}`);
        assert.deepEqual(seen, [
            `PATCH /api/v1/robots/${ROB}`,
            `DELETE /api/v1/robots/${ROB}`,
            `POST /api/v1/robots/${ROB}/pairing-code`,
            `POST /api/v1/robots/${ROB}/operators`,
            `DELETE /api/v1/robots/${ROB}/operators/${USR}`,
            `GET /api/v1/robots/${ROB}/devices`,
            `POST /api/v1/robots/${ROB}/estop`,
            `POST /api/v1/robots/${ROB}/estop/clear`,
            `GET /api/v1/robots/${ROB}/streaming`,
            `POST /api/v1/robots/${ROB}/streaming`,
            `POST /api/v1/devices/${DEV}/rotate`,
            `POST /api/v1/devices/${DEV}/revoke`,
        ]);
        assert.deepEqual(JSON.parse(srv.requests[0].body), { name: 'R2' });
        assert.deepEqual(JSON.parse(srv.requests[3].body), { subject: USR, role: 'operator' });
        assert.deepEqual(JSON.parse(srv.requests[9].body), { to: 'openre', on: true });
        await srv.close();
    }],

    ['public profiles and kits, and pairing (a one-time code is never given an Idempotency-Key)', async () => {
        const srv = await server();
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url } }));
        assert.deepEqual(await bot.profiles.get('adeept.adr036'), { profile: loadFixture('bot.robot-profile', 'adeept-file.json') });
        assert.equal(await bot.profiles.get('missing'), null);
        assert.equal((await bot.profiles.list()).profiles.length, 1);
        assert.deepEqual(await bot.kits.list(), { kits: [{ id: 'starter' }] });
        assert.deepEqual(await bot.kits.get('starter'), { kit: { id: 'starter' } });
        const pair = loadFixture('bot.pair-request', 'code-only.json');
        assert.deepEqual(await bot.pair(pair), loadFixture('bot.pair-result', 'paired.json'));
        const r = srv.requests[srv.requests.length - 1];
        assert.equal(r.url, '/api/v1/pair');
        assert.deepEqual(JSON.parse(r.body), pair);
        assert.equal(hdr(r, 'idempotency-key'), undefined, 'a one-time code is its own idempotency: no retry key');
        await srv.close();
    }],

    ['browser mode: cookie credentials, no Authorization and no X-OV headers', async () => {
        const srv = await server();
        const seen = [];
        const fetchSpy = (url, init) => { seen.push(init); return fetch(url, init); };
        const bot = createBotClient(createClient({ baseUrls: { bot: srv.url }, credentials: 'include', fetch: fetchSpy }));
        await bot.robots.get(ROB);
        const r = srv.requests[0];
        assert.equal(hdr(r, 'authorization'), undefined);
        assert.ok(!Object.keys(r.headers).some((k) => k.startsWith('x-ov-')));
        assert.equal(seen[0].credentials, 'include');
        await srv.close();
    }],

    ['the Contracts bot fixtures validate (requests and answers the client speaks)', async () => {
        if (!contracts) { console.log('bot fixtures: skipped (openvibe-contracts not installed)'); return; }
        const cases = [
            ['bot.robot', 'bot.robot@1'],
            ['bot.device', 'bot.device@1'],
            ['bot.command', 'bot.command@1'],
            ['bot.command-result', 'bot.command-result@1'],
            ['bot.robot-manage-request', 'bot.robot-manage-request@1'],
            ['bot.robot-manage-result', 'bot.robot-manage-result@1'],
            ['bot.robot-read-request', 'bot.robot-read-request@1'],
            ['bot.robot-read-result', 'bot.robot-read-result@1'],
            ['bot.robot-control-result', 'bot.robot-control-result@1'],
            ['bot.device-connect-result', 'bot.device-connect-result@1'],
            ['bot.device-message', 'bot.device-message@1'],
            ['bot.job-dispatch-result', 'bot.job-dispatch-result@1'],
            ['bot.pair-request', 'bot.pair-request@1'],
            ['bot.pair-result', 'bot.pair-result@1'],
            ['bot.robot-profile', 'bot.robot-profile@1'],
        ];
        for (const [dir, ref] of cases) {
            for (const f of fs.readdirSync(path.join(FIX, dir, 'valid'))) {
                const body = JSON.parse(fs.readFileSync(path.join(FIX, dir, 'valid', f), 'utf8'));
                assert.deepEqual(contracts.validate(ref, body), { valid: true, errors: [] }, `${ref} valid/${f}`);
            }
            for (const f of fs.readdirSync(path.join(FIX, dir, 'invalid'))) {
                const body = JSON.parse(fs.readFileSync(path.join(FIX, dir, 'invalid', f), 'utf8'));
                assert.equal(contracts.validate(ref, body).valid, false, `${ref} invalid/${f}`);
            }
        }
    }],
]);
