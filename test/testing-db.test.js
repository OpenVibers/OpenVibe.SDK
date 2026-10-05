'use strict';
/** openvibe-sdk/testing createTestDb: a migrated PGlite database; on the containers, parallel setups do not race. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./helpers');
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
    ['snapshot: a lock left by a builder that died is broken', async () => {
        const m = migrationsDir('CREATE TABLE stale (id int);');
        fs.writeFileSync(`${snapshotFile({ migrations: m })}.lock`, `2147483646 ${Date.now()}`);
        const t = await createTestDb({ migrations: m, service: 'sdk' });
        try { assert.equal(t.snapshot, 'built'); } finally { await t.close(); }
        assert.deepEqual(leftovers(), []);
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
} else console.log('createTestDb on the containers: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');
tests.push(['(the snapshots made here are removed)', async () => { fs.rmSync(snaps, { recursive: true, force: true }); }]);

run(tests);
