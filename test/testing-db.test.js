'use strict';
/** openvibe-sdk/testing createTestDb: a migrated PGlite database; on the containers, parallel setups do not race. */
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, waitFor } = require('./helpers');
const { createTestDb, pgAvailable } = require('../src/testing');
const { runName, runTime, isRunSchema, leaseKey, sweepOrphans, snapshotKey } = require('../src/testing/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-'));
fs.writeFileSync(path.join(dir, '0001_initial.sql'), '-- phase: expand\nCREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL);\n');
// Snapshots of this file's databases go to a directory of its own, removed at the end.
const snaps = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-snap-'));
process.env.OV_TEST_SNAPSHOT_DIR = snaps;
delete process.env.OV_TEST_SNAPSHOT;
const migrationsDir = (sql) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-'));
    fs.writeFileSync(path.join(d, '0001_initial.sql'), `-- phase: expand\n${sql}\n`);
    return d;
};
const snapshotFile = (o) => path.join(snaps, `${snapshotKey(o)}.pgdata`);
const leftovers = () => fs.readdirSync(snaps).filter((f) => !f.endsWith('.pgdata'));
const tests = [
    ['pglite: migrated and usable', async () => {
        const t = await createTestDb({ migrations: dir, service: 'sdk' });
        try {
            assert.equal(t.store, 'pglite');
            assert.ok(['built', 'hit'].includes(t.snapshot), t.snapshot); assert.equal(typeof t.setupMs, 'number');
            await t.db.prepare('INSERT INTO notes (body) VALUES (?)').run('hi');
            assert.equal(await t.db.value('SELECT count(*)::int FROM notes'), 1);
        } finally { await t.close(); }
    }],
    ['snapshot: the second database with the same migrations loads it; tables there, the first one\'s rows not', async () => {
        const m = migrationsDir('CREATE TABLE items (id int PRIMARY KEY, label text NOT NULL);');
        const a = await createTestDb({ migrations: m, service: 'sdk' });
        try {
            assert.equal(a.snapshot, 'built');
            assert.ok(fs.existsSync(snapshotFile({ migrations: m })));
            await a.db.query('INSERT INTO items VALUES (1, $1)', ['first']);
        } finally { await a.close(); }
        const b = await createTestDb({ migrations: m, service: 'sdk' });
        try {
            assert.equal(b.snapshot, 'hit');
            assert.equal(await b.db.value('SELECT count(*)::int FROM items'), 0, 'data written by the first is not in the snapshot');
            assert.equal(await b.db.value('SELECT count(*)::int FROM ov_migrations'), 1, 'migrations recorded');
            await b.db.query('INSERT INTO items VALUES (2, $1)', ['second']);
            assert.deepEqual(await b.db.many('SELECT id, label FROM items'), [{ id: 2, label: 'second' }]);
        } finally { await b.close(); }
        // Changed migration content is another key: built afresh, with the new schema.
        fs.writeFileSync(path.join(m, '0001_initial.sql'), '-- phase: expand\nCREATE TABLE items (id int PRIMARY KEY, label text NOT NULL, extra text);\n');
        const c = await createTestDb({ migrations: m, service: 'sdk' });
        try {
            assert.equal(c.snapshot, 'built');
            await c.db.query("INSERT INTO items VALUES (3, 'c', 'x')");
        } finally { await c.close(); }
        // A new migration file misses too.
        fs.writeFileSync(path.join(m, '0002_more.sql'), '-- phase: expand\nCREATE TABLE more (id int);\n');
        const d = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(d.snapshot, 'built'); assert.equal(await d.db.value('SELECT count(*)::int FROM more'), 0); } finally { await d.close(); }
        assert.deepEqual(leftovers(), [], 'no lock or temporary file left');
    }],
    ['snapshot: a corrupt file is deleted and rebuilt, never failing the test', async () => {
        const m = migrationsDir('CREATE TABLE c (id int);');
        fs.writeFileSync(snapshotFile({ migrations: m }), 'not a data directory');
        const a = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(a.snapshot, 'built'); assert.equal(await a.db.value('SELECT count(*)::int FROM c'), 0); } finally { await a.close(); }
        assert.ok(fs.statSync(snapshotFile({ migrations: m })).size > 1000, 'rebuilt');
        const b = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(b.snapshot, 'hit'); } finally { await b.close(); }
    }],
    ['snapshot: concurrent builders make one file; the others wait and load it', async () => {
        const m = migrationsDir('CREATE TABLE par (id int);');
        const all = await Promise.all([1, 2, 3].map(() => createTestDb({ migrations: m, service: 'sdk' })));
        try {
            assert.deepEqual(all.map((t) => t.snapshot).sort(), ['built', 'hit', 'hit']);
            await all[0].db.query('INSERT INTO par VALUES (1)');
            for (const t of all.slice(1)) assert.equal(await t.db.value('SELECT count(*)::int FROM par'), 0, 'each its own database');
        } finally { await Promise.all(all.map((t) => t.close())); }
        assert.equal(fs.readdirSync(snaps).filter((f) => f.startsWith(snapshotKey({ migrations: m }))).length, 1);
        assert.deepEqual(leftovers(), []);
    }],
    ['snapshot: a builder in another process holds the lock; this process waits and loads its file', async () => {
        const m = migrationsDir('CREATE TABLE crossing (id int);');
        const seed = async () => {}; const seedKey = 'slow-build';
        const lock = `${snapshotFile({ migrations: m, seed, seedKey })}.lock`;
        const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-child-')), 'build.js');
        fs.writeFileSync(script, `'use strict';
const { createTestDb } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'testing', 'db'))});
(async () => {
    const t = await createTestDb({ migrations: process.argv[2], seed: async () => { await new Promise((r) => setTimeout(r, 2500)); }, seedKey: 'slow-build', service: 'sdk' });
    if (process.send) process.send({ snapshot: t.snapshot });
    await t.close();
})().catch((e) => { if (process.send) process.send({ error: e.message }); process.exit(1); });
`);
        const child = fork(script, [m], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const built = new Promise((resolve, reject) => {
            child.on('message', (msg) => { if (msg && msg.error) reject(new Error(msg.error)); else resolve(msg); });
            child.on('exit', (code, signal) => reject(new Error(`snapshot builder exited (${code == null ? signal : code})`)));
        });
        built.catch(() => {});   // the waiter may fail before the child exits; keep that rejection handled
        try {
            await waitFor(() => fs.existsSync(lock), { timeoutMs: 30000 });
            const t0 = Date.now();
            const t = await createTestDb({ migrations: m, seed, seedKey, service: 'sdk' });
            try {
                assert.equal(t.snapshot, 'hit', 'the other process built it; this one loaded it');
                assert.ok(Date.now() - t0 >= 100, 'this process waited for the live builder instead of breaking its lock');
            } finally { await t.close(); }
            assert.deepEqual(await built, { snapshot: 'built' });
        } finally { child.kill('SIGKILL'); }
        assert.deepEqual(leftovers(), []);
    }],
    ['snapshot: a lock left by a builder that died is broken', async () => {
        const m = migrationsDir('CREATE TABLE stale (id int);');
        fs.writeFileSync(`${snapshotFile({ migrations: m })}.lock`, `2147483646 ${Date.now()}`);
        const t = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(t.snapshot, 'built'); } finally { await t.close(); }
        assert.deepEqual(leftovers(), []);
    }],
    ['snapshot: a test that never closes its database still exits (PGlite\'s alarm timers are unref\'d)', async () => {
        const m = migrationsDir('CREATE TABLE left_open (id int);');
        const first = await createTestDb({ migrations: m, service: 'sdk' }); await first.close();   // the snapshot exists now
        const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-child-')), 'open.js');
        fs.writeFileSync(script, `'use strict';
const { createTestDb } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'testing', 'db'))});
(async () => {
    const t = await createTestDb({ migrations: process.argv[2], service: 'sdk' });
    await t.db.query('INSERT INTO left_open VALUES (1)');
    const n = await t.db.value('SELECT count(*)::int FROM left_open');
    await new Promise((r) => setTimeout(r, 300));   // a test's own timer still runs: ref'd as ever
    process.send({ snapshot: t.snapshot, n });
})().catch((e) => { process.send({ error: e.message }); process.exit(1); });
`);
        const child = fork(script, [m], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const t0 = Date.now();
        let msg = null;
        child.on('message', (x) => { msg = x; });
        const code = await new Promise((resolve) => {
            const kill = setTimeout(() => { child.kill('SIGKILL'); resolve('still running after 30 s'); }, 30000);
            child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
        });
        assert.deepEqual(msg, { snapshot: 'hit', n: 1 });
        assert.equal(code, 0, 'the child exited by itself');
        assert.ok(Date.now() - t0 < 9000, `without waiting out the 10 s alarm (${Date.now() - t0} ms)`);
    }],
    ['snapshot: OV_TEST_SNAPSHOT=0 migrates every time and writes nothing', async () => {
        const m = migrationsDir('CREATE TABLE off (id int);');
        process.env.OV_TEST_SNAPSHOT = '0';
        try {
            for (let i = 0; i < 2; i++) {
                const t = await createTestDb({ migrations: m, service: 'sdk' });
                try { assert.equal(t.snapshot, 'off'); assert.equal(await t.db.value('SELECT count(*)::int FROM off'), 0); } finally { await t.close(); }
            }
            assert.equal(fs.existsSync(snapshotFile({ migrations: m })), false);
        } finally { delete process.env.OV_TEST_SNAPSHOT; }
    }],
    ['snapshot: the seed runs once per key and its rows are there after a hit', async () => {
        const m = migrationsDir('CREATE TABLE users (id int PRIMARY KEY, name text NOT NULL);');
        let runs = 0;
        const seed = async (db) => { runs++; await db.query("INSERT INTO users VALUES (1, 'admin')"); };
        for (const want of ['built', 'hit', 'hit']) {
            const t = await createTestDb({ migrations: m, seed, seedKey: 'v1', service: 'sdk' });
            try {
                assert.equal(t.snapshot, want);
                assert.deepEqual(await t.db.many('SELECT id, name FROM users'), [{ id: 1, name: 'admin' }]);
            } finally { await t.close(); }
        }
        assert.equal(runs, 1);
        const other = await createTestDb({ migrations: m, seed, seedKey: 'v2', service: 'sdk' });
        try { assert.equal(other.snapshot, 'built'); } finally { await other.close(); }
        assert.equal(runs, 2, 'another seedKey is another snapshot');
        const plain = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(plain.snapshot, 'built'); assert.equal(await plain.db.value('SELECT count(*)::int FROM users'), 0, 'no seed, no rows'); } finally { await plain.close(); }
    }],
    ['snapshot: a seedKey without a seed is not the same snapshot as one with both', async () => {
        const m = migrationsDir('CREATE TABLE keyed (id int PRIMARY KEY, name text);');
        const seed = async (db) => { await db.query("INSERT INTO keyed VALUES (1, 'admin')"); };
        assert.notEqual(snapshotKey({ migrations: m, seedKey: 'v1' }), snapshotKey({ migrations: m, seed, seedKey: 'v1' }), 'the keys differ');
        const bare = await createTestDb({ migrations: m, seedKey: 'v1', service: 'sdk' });
        try { assert.equal(bare.snapshot, 'built'); assert.equal(await bare.db.value('SELECT count(*)::int FROM keyed'), 0); } finally { await bare.close(); }
        const seeded = await createTestDb({ migrations: m, seed, seedKey: 'v1', service: 'sdk' });
        try {
            assert.equal(seeded.snapshot, 'built', 'the unseeded snapshot is not served to a seeded call');
            assert.equal(await seeded.db.value('SELECT count(*)::int FROM keyed'), 1, 'the seed ran');
        } finally { await seeded.close(); }
    }],
    ['snapshot: a fresh build applies its ADR-028 contract (no previous release exists), and a hit is that same schema', async () => {
        const m = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-'));
        fs.writeFileSync(path.join(m, '0001_expand.sql'), '-- phase: expand\nCREATE TABLE legacy (id int);\n');
        fs.writeFileSync(path.join(m, '0002_contract.sql'), '-- phase: contract\n-- after: 0001\nCREATE TABLE contracted (id int);\n');
        // The seed ages the expand; a snapshot built more than windowDays ago looks exactly like this to a hit.
        const seed = async (db) => { await db.query("UPDATE ov_migrations SET applied_at = now() - interval '30 days'"); };
        const a = await createTestDb({ migrations: m, seed, service: 'sdk' });
        try { assert.equal(a.snapshot, 'built'); } finally { await a.close(); }
        const b = await createTestDb({ migrations: m, seed, service: 'sdk' });
        try {
            assert.equal(b.snapshot, 'hit');
            assert.equal(await b.db.value("SELECT to_regclass('contracted')::text"), 'contracted', 'the contract ran when the snapshot was built');
            assert.equal(await b.db.value("SELECT count(*)::int FROM ov_migrations WHERE id = '0002'"), 1, 'the contract is recorded');
        } finally { await b.close(); }
    }],
    ['a run\'s schema name carries when it was made (so a killed run\'s leftovers can be swept); an older name has none', async () => {
        const t0 = Date.now(), n = runName('sdk', t0);
        assert.match(n, /^sdk_t[0-9a-z]{8,9}_[0-9a-f]{8}_l$/); assert.ok(n.length < 50);
        assert.equal(runTime(n), t0); assert.equal(runTime('sdk_t12345_abcdef01'), null);
        assert.equal(runTime(n.slice(0, -2)), null, 'unleased names must never be swept');
    }],
    ['the sweep takes only the exact generated shape (a catalog name reaches SQL quoted, and only if it matches whole)', async () => {
        assert.equal(isRunSchema(runName('sdk')), true); assert.equal(isRunSchema(runName('abcdefghijkl')), true);
        const tail = runName('sdk').slice(3);
        for (const bad of [`x"; DROP ROLE ov; --${tail}`, `SDK${tail}`, `a-b${tail}`, `abcdefghijklm${tail}`, tail.slice(1), `sdk${tail}\n`]) assert.equal(isRunSchema(bad), false, bad);
    }],
];
if (pgAvailable()) {
    tests.push(['postgresql+pgbouncer: four setups at once each get their own schema, and close() drops them', async () => {
        const all = await Promise.all([1, 2, 3, 4].map(() => createTestDb({ migrations: dir, store: 'pg', service: 'sdk' })));
        try {
            assert.equal(new Set(all.map((t) => t.schema)).size, 4);
            await Promise.all(all.map((t, i) => t.db.prepare('INSERT INTO notes (body) VALUES (?)').run(`n${i}`)));
            for (const t of all) assert.equal(await t.db.value('SELECT count(*)::int FROM notes'), 1, 'isolated');
        } finally { await Promise.all(all.map((t) => t.close())); }
    }]);
    tests.push(['a live run keeps its schema after its query pool idles; a released lease permits sweeping', async () => {
        const { createDb } = require('../src/db');
        const { Client } = require('pg');
        const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'sdk-sweep-test', max: 1 });
        const stale = runName('sdk', Date.now() - 7 * 3600e3), fresh = runName('sdk', Date.now() - 60e3);
        const lease = new Client({ connectionString: process.env.OV_TEST_PG_DIRECT_URL });
        let leased = false;
        try {
            for (const n of [stale, fresh]) for (const q of [`CREATE ROLE ${n}_owner LOGIN`, `CREATE ROLE ${n} LOGIN`, `CREATE SCHEMA ${n} AUTHORIZATION ${n}_owner`, `CREATE TABLE ${n}.t (id int)`]) await su.query(q);
            await lease.connect(); leased = true;
            await lease.query('SELECT pg_advisory_lock($1::bigint)', [leaseKey(stale)]);
            const t = await createTestDb({ migrations: dir, store: 'pg', service: 'sdk' }); await t.close();
            let left = (await su.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [[stale, fresh]])).rows.map((r) => r.nspname);
            assert.deepEqual(left.sort(), [stale, fresh].sort(), 'the held lease preserves the stale run');
            await lease.end(); leased = false;
            await sweepOrphans(su);
            left = (await su.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [[stale, fresh]])).rows.map((r) => r.nspname);
            assert.deepEqual(left, [fresh], 'the released lease permits sweeping; the recent run stays');
            assert.equal(+(await su.value('SELECT count(*) FROM pg_roles WHERE rolname = ANY($1)', [[stale, `${stale}_owner`]])), 0, 'its roles too');
        } finally {
            if (leased) await lease.end().catch(() => {});
            for (const q of [`DROP SCHEMA IF EXISTS ${fresh} CASCADE`, `DROP ROLE IF EXISTS ${fresh}`, `DROP ROLE IF EXISTS ${fresh}_owner`]) await su.query(q).catch(() => {});
            await su.close();
        }
    }]);
    tests.push(['postgresql: seed runs with the schema owner\'s rights, as on PGlite', async () => {
        const m = migrationsDir('CREATE TABLE seeded (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL);');
        const seed = async (db) => {
            await db.query("INSERT INTO seeded (label) VALUES ('admin')");
            await db.query('ALTER SEQUENCE seeded_id_seq RESTART WITH 100');   // owner-only: the runtime role may not
        };
        const t = await createTestDb({ migrations: m, store: 'pg', seed, service: 'sdk' });
        try {
            assert.equal(await t.db.value("SELECT nextval('seeded_id_seq')"), 100);
            assert.equal(await t.db.value('SELECT count(*)::int FROM seeded'), 1);
        } finally { await t.close(); }
    }]);
} else console.log('createTestDb on the containers: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');
tests.push(['(the snapshots made here are removed)', async () => { fs.rmSync(snaps, { recursive: true, force: true }); }]);

run(tests);
