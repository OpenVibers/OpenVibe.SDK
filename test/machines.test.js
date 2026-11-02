'use strict';
/**
 * openvibe-sdk/machines (plan L34, step M2): the network's machines hub. What this proves:
 *   - every call goes to the hub's own route with the caller's bearer token;
 *   - the answers are the hub's own shapes (machines, machine, roles, pairing);
 *   - a refusal is an error with the hub's status and code, so a caller can tell them apart;
 *   - a hub that does not answer is a timeout, not a hang.
 */
const assert = require('node:assert/strict');
const { stubServer, send, run, sleep } = require('./helpers');
const { createMachines, DEFAULT_TIMEOUT_MS } = require('../src/machines');

const MACHINE = { id: 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'server', online: true, roles: ['codes.worker'], running: [] };

async function hub(answer) {
    const state = { requests: [], token: 'person-token' };
    const stub = await stubServer(async (req, res, body) => {
        state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? body.toString() : '' });
        const a = answer(req, body, state.requests.length);
        if (!a || a.hang) return await new Promise(() => {});
        if (a.delayMs) await sleep(a.delayMs);
        send(res, a.status || 200, a.body === undefined ? '' : a.body);
    });
    return { stub, state };
}

run([
    ['the default timeout is ten seconds', async () => {
        assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
    }],

    ['the calls are the hub\'s own routes, with the caller\'s token', async () => {
        const { stub, state } = await hub((req) => {
            if (req.url === '/api/v1/machines' && req.method === 'GET') return { body: { machines: [MACHINE] } };
            if (req.url === '/api/v1/machines/roles') return { body: { roles: [{ id: 'codes.worker', name: 'Codes worker', installs: 'the runner', shows: 'Runs your coding jobs.' }] } };
            if (req.url.endsWith('/roles') && req.method === 'PUT') return { body: { machine: { ...MACHINE, roles: ['codes.worker', 'desks.host'] } } };
            if (req.url.endsWith('/revoke')) return { body: { machine: { ...MACHINE, online: false } } };
            if (req.url === '/api/v1/machines/pairings') return { body: { pairing: { code: 'ABCD-EFGH', expires_at: '2026-10-31T12:00:00.000Z', installer: 'curl -fsSL https://openvibe.bot/install | sh' } } };
            if (req.method === 'PATCH') return { body: { machine: { ...MACHINE, name: 'Studio' } } };
            return { body: { machine: MACHINE } };
        });
        const machines = createMachines({ networkUrl: stub.url, token: () => state.token });
        try {
            const list = await machines.list();
            assert.equal(list.machines.length, 1);
            assert.equal(list.machines[0].id, MACHINE.id);
            assert.equal((await machines.get(MACHINE.id)).machine.kind, 'server');
            assert.equal((await machines.catalogue()).roles[0].id, 'codes.worker');
            assert.equal((await machines.pair()).pairing.code, 'ABCD-EFGH');
            assert.equal((await machines.rename(MACHINE.id, 'Studio')).machine.name, 'Studio');
            assert.deepEqual((await machines.roles(MACHINE.id, ['codes.worker', 'desks.host'])).machine.roles, ['codes.worker', 'desks.host']);
            assert.equal((await machines.revoke(MACHINE.id)).machine.online, false);
            for (const r of state.requests) {
                assert.equal(r.headers.authorization, 'Bearer person-token', 'every call carries the caller\'s token');
            }
            assert.equal(state.requests[4].body, JSON.stringify({ name: 'Studio' }));
            assert.equal(state.requests[5].body, JSON.stringify({ roles: ['codes.worker', 'desks.host'] }));
        } finally { await stub.close(); }
    }],

    ['a refusal is an error with the hub\'s status and code', async () => {
        const { stub } = await hub(() => ({ status: 403, body: { code: 'capability.denied', detail: 'network.machines.read not granted' } }));
        const machines = createMachines({ networkUrl: stub.url, token: () => 'person-token' });
        try {
            await assert.rejects(() => machines.list(), (e) => {
                assert.equal(e.name, 'MachinesError');
                assert.equal(e.status, 403);
                assert.equal(e.code, 'capability.denied');
                return true;
            });
        } finally { await stub.close(); }
    }],

    ['a hub that does not answer is a timeout, not a hang', async () => {
        const { stub } = await hub(() => ({ hang: true }));
        const machines = createMachines({ networkUrl: stub.url, token: () => 'person-token', timeoutMs: 200 });
        try {
            await assert.rejects(() => machines.list(), (e) => {
                assert.equal(e.code, 'machines.timeout');
                return true;
            });
        } finally { await stub.close(); }
    }],

    ['no token is refused before anything is asked', async () => {
        const { stub, state } = await hub(() => ({ body: { machines: [] } }));
        const machines = createMachines({ networkUrl: stub.url, token: () => '' });
        try {
            await assert.rejects(() => machines.list(), (e) => e.code === 'token.invalid');
            assert.equal(state.requests.length, 0, 'the hub was never asked');
        } finally { await stub.close(); }
    }],
]);
