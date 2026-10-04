'use strict';
/** openvibe-sdk/testing createTestDb: a migrated PGlite database; on the containers, parallel setups do not race. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./helpers');
const { createTestDb, pgAvailable } = require('../src/testing');
const { runName, runTime, leaseKey, sweepOrphans } = require('../src/testing/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-testdb-'));
fs.writeFileSync(path.join(dir, '0001_initial.sql'), '-- phase: expand\nCREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL);\n');

const tests = [
    ['pglite: migrated and usable', async () => {
        const t = await createTestDb({ migrations: dir, service: 'sdk' });
        try {
            assert.equal(t.store, 'pglite');
            await t.db.prepare('INSERT INTO notes (body) VALUES (?)').run('hi');
            assert.equal(await t.db.value('SELECT count(*)::int FROM notes'), 1);
        } finally { await t.close(); }
    }],
    ['a run\'s schema name carries when it was made (so a killed run\'s leftovers can be swept); an older name has none', async () => {
        const t0 = Date.now(), n = runName('sdk', t0);
        assert.match(n, /^sdk_t[0-9a-z]{8,9}_[0-9a-f]{8}_l$/); assert.ok(n.length < 50);
        assert.equal(runTime(n), t0); assert.equal(runTime('sdk_t12345_abcdef01'), null);
        assert.equal(runTime(n.slice(0, -2)), null, 'unleased names must never be swept');
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

run(tests);
