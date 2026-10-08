'use strict';
/**
 * openvibe-sdk/account-data against real PostgreSQL (PGlite) and a stand-in Network: the export part, the erase
 * (delete, anonymize, keep, aliases), idempotency per export/deletion id, retries, and the signed consumer.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { run, stubServer } = require('./helpers');
const { createDb } = require('../src/db');
const { signDeliveryHeaders } = require('../src/events');
const { createAccountData, createNetworkSender, ACCOUNT_DATA_SCHEMA, TOPICS } = require('../src/account-data');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const OLD = 'usr_01JZ0000000000000000000MRG';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
// Fixture secrets, built so they never look like a real key to a scanner.
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const WRONG = `whsec_${'mismatch'.repeat(5)}`;
const quiet = { log() {}, warn() {} };

async function setup() {
    const db = createDb({ pglite: true });
    await db.exec(`CREATE TABLE plans (id TEXT PRIMARY KEY, owner TEXT, title TEXT, created_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE posts (id TEXT PRIMARY KEY, author TEXT, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE ledger (id TEXT PRIMARY KEY, subject TEXT, amount INT, secret_note TEXT)`);
    await db.exec(`INSERT INTO plans (id, owner, title, created_at) VALUES
        ('p1', 'user:${A}', 'week one', '2026-10-01T00:00:00Z'), ('p2', 'user:${A}', 'week two', '2026-10-02T00:00:00Z'),
        ('p3', 'user:${B}', 'not yours', '2026-10-02T00:00:00Z'), ('p4', 'user:${OLD}', 'from the merged account', '2026-09-01T00:00:00Z');
        INSERT INTO posts (id, author, body) VALUES ('s1', '${A}', 'hello'), ('s2', '${B}', 'reply');
        INSERT INTO ledger (id, subject, amount, secret_note) VALUES ('l1', '${A}', 5, 'staff only')`);
    const accountData = createAccountData({
        db, service: 'food', log: quiet, rowLimit: 1,
        tables: [
            { table: 'plans', subject: 'owner', value: (s) => `user:${s}`, file: 'plans.json' },
            { table: 'posts', subject: 'author', erase: { anonymize: { body: '[deleted]' } } },
            { table: 'ledger', subject: 'subject', columns: ['id', 'amount'], erase: { keep: 'a ledger' } },
            { table: 'not_created_yet', subject: 'owner' },
        ],
    });
    await accountData.ensureSchema();
    return { db, accountData };
}

async function network({ partStatus = 201, confirmStatus = 201 } = {}) {
    const calls = [];
    const stub = await stubServer(async (req, res, body) => {
        if (req.url === '/oauth/token') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ access_token: 'tok', expires_in: 300 })); }
        calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body.toString() || 'null') });
        res.statusCode = req.url.includes('/parts') ? (typeof partStatus === 'function' ? partStatus() : partStatus) : (typeof confirmStatus === 'function' ? confirmStatus() : confirmStatus);
        res.end('{}');
    });
    const send = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'food', clientSecret: 'secret' });
    return { stub, calls, send };
}

const exportEvent = { event_id: 'evt_1', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_2', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [OLD] } };

run([
    ['a table map that could inject SQL or write a bad file name is refused when it is made', async () => {
        const db = createDb({ pglite: true });
        assert.throws(() => createAccountData({ db, service: 'x', tables: [{ table: 'plans; DROP TABLE x', subject: 'owner' }] }), /plain identifier/);
        assert.throws(() => createAccountData({ db, service: 'x', tables: [{ table: 'plans', subject: 'owner', file: '../plans.json' }] }), /flat name/);
        assert.throws(() => createAccountData({ db, service: 'x', tables: [{ table: 'a', subject: 's', file: 'f.json' }, { table: 'b', subject: 's', file: 'f.json' }] }), /two tables/);
        assert.throws(() => createAccountData({ db, service: 'x', tables: [{ table: 'a', subject: 's', erase: 'shred' }] }), /erase is/);
        assert.deepEqual(TOPICS, ['network.account.export_requested', 'network.account.deleted']);
        assert.match(ACCOUNT_DATA_SCHEMA, /account_data_events/);
        await db.close();
    }],

    ['the export part: the person\'s rows in their stored form, listed columns only, cut at the row limit, missing tables skipped', async () => {
        const { db, accountData } = await setup();
        const part = await accountData.exportPart(A);
        assert.equal(part.subject, A);
        assert.deepEqual(part.files.map((f) => f.name), ['plans.json', 'posts.json', 'ledger.json']);
        const plans = part.files.find((f) => f.name === 'plans.json').content;
        assert.equal(plans.length, 1, 'cut at rowLimit 1');
        assert.equal(plans[0].id, 'p2', 'newest first');
        assert.deepEqual(part.truncated, ['plans.json']);
        assert.deepEqual(Object.keys(part.files.find((f) => f.name === 'ledger.json').content[0]).sort(), ['amount', 'id'], 'only the listed columns');
        assert.ok(!JSON.stringify(part).includes('not yours'), 'nobody else\'s rows');
        await db.close();
    }],

    ['an export is pushed once with the service token; a redelivery is unchanged; a closed export is closed; a refusal is retried', async () => {
        const { db, accountData } = await setup();
        const { stub, calls, send } = await network();
        assert.equal(await accountData.apply(exportEvent, { send }), 'exported');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `/internal/account-exports/${EXP}/parts`);
        assert.equal(calls[0].auth, 'Bearer tok');
        assert.equal(calls[0].body.subject, A);
        assert.equal(await accountData.apply(exportEvent, { send }), 'unchanged');
        assert.equal(calls.length, 1, 'not sent twice');
        await stub.close();

        const late = await network({ partStatus: 409 });
        const other = { ...exportEvent, payload: { export_id: 'exp_01JZ0000000000000000000TAR', subject: A } };
        assert.equal(await accountData.apply(other, { send: late.send }), 'closed');
        await late.stub.close();

        const down = await network({ partStatus: 500 });
        const third = { ...exportEvent, payload: { export_id: 'exp_01JZ0000000000000000000RTY', subject: A } };
        await assert.rejects(accountData.apply(third, { send: down.send }), /refused \(500\)/);
        await down.stub.close();
        await db.close();
    }],

    ['a deletion erases the account and its merged aliases once, keeps what it must, confirms with counts, and retries only the confirmation', async () => {
        const { db, accountData } = await setup();
        let fail = true;
        const { stub, calls, send } = await network({ confirmStatus: () => (fail ? 503 : 201) });
        await assert.rejects(accountData.apply(deleteEvent, { send }), /confirmation refused \(503\)/);
        assert.equal(await db.value(`SELECT COUNT(*)::int FROM plans WHERE owner IN ('user:${A}', 'user:${OLD}')`), 0, 'both forms erased');
        assert.equal(await db.value(`SELECT COUNT(*)::int FROM plans WHERE owner = 'user:${B}'`), 1, 'someone else\'s plan stays');
        const post = await db.maybe("SELECT author, body FROM posts WHERE id = 's1'");
        assert.deepEqual(post, { author: null, body: '[deleted]' }, 'anonymized, not deleted');
        assert.equal(await db.value("SELECT COUNT(*)::int FROM ledger"), 1, 'the ledger is kept');

        // Someone writes a new plan under the same id form before the redelivery: the redelivery must not erase again.
        await db.exec(`INSERT INTO plans (id, owner, title) VALUES ('p9', 'user:${A}', 'written later')`);
        fail = false;
        assert.equal(await accountData.apply(deleteEvent, { send }), 'confirmed');
        assert.equal(await db.value("SELECT COUNT(*)::int FROM plans WHERE id = 'p9'"), 1, 'not erased twice');
        const confirmation = calls[calls.length - 1];
        assert.equal(confirmation.url, `/internal/account-deletions/${DEL}/confirmations`);
        assert.deepEqual(confirmation.body.erased, { plans: 3 });
        assert.deepEqual(confirmation.body.retained, { tombstones: 1, ledger: 1 });
        assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        assert.equal(await accountData.apply(deleteEvent, { send }), 'unchanged');
        await stub.close();
        await db.close();
    }],

    ['events that are not Network\'s account events, or carry a bad payload, are ignored', async () => {
        const { db, accountData } = await setup();
        const send = async () => { throw new Error('must not send'); };
        assert.equal(await accountData.apply({ event_type: 'live.stream.started', source: 'live' }, { send }), 'ignored:type');
        assert.equal(await accountData.apply({ ...exportEvent, source: 'chat' }, { send }), 'ignored:source');
        assert.equal(await accountData.apply({ ...exportEvent, payload: { export_id: 'nope', subject: A } }, { send }), 'ignored:payload');
        assert.equal(await accountData.apply({ ...deleteEvent, payload: { deletion_id: DEL, subject: 'user:1' } }, { send }), 'ignored:payload');
        await db.close();
    }],

    ['the consumer: v2 signature only, loopback only, 503 without a secret, other topics to onEvent, a failure asks for a retry', async () => {
        const { db, accountData } = await setup();
        const { stub, send } = await network();
        const seen = [];
        const handler = accountData.consumer({ secrets: [SECRET], send, onEvent: (ev) => { seen.push(ev.event_type); return 'noted'; } });
        const bare = accountData.consumer({ secrets: [], send });
        const server = http.createServer((req, res) => (req.url === '/bare' ? bare(req, res) : handler(req, res)));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = async (ev, { secret = SECRET, headers = {}, path = '/' } = {}) => {
            const body = JSON.stringify({ event: ev, seq: 1 });
            const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers }, body });
            return { status: res.status, json: await res.json() };
        };
        try {
            assert.equal((await post(exportEvent)).json.outcome, 'exported');
            assert.equal((await post(exportEvent, { secret: WRONG })).status, 401);
            assert.equal((await post(exportEvent, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
            assert.equal((await post(exportEvent, { path: '/bare' })).status, 503);
            const other = await post({ event_id: 'evt_9', event_type: 'live.stream.started', source: 'live', payload: {} });
            assert.deepEqual([other.status, other.json.outcome, seen], [200, 'noted', ['live.stream.started']]);
            await stub.close();   // Network down: the delivery must be retried, not acknowledged
            const retry = await post({ ...exportEvent, payload: { export_id: 'exp_01JZ0000000000000000000DWN', subject: A } });
            assert.equal(retry.status, 503);
        } finally {
            await new Promise((r) => server.close(r));
            await db.close();
        }
    }],
]);
