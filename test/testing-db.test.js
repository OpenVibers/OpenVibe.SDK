'use strict';
/** openvibe-sdk/testing createTestDb: a migrated PGlite database; on the containers, parallel setups do not race. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./helpers');
const { createTestDb, pgAvailable } = require('../src/testing');
const { runName, runTime } = require('../src/testing/db');

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
        assert.match(n, /^sdk_t[0-9a-z]{8,9}_[0-9a-f]{8}$/); assert.ok(n.length < 50);
        assert.equal(runTime(n), t0); assert.equal(runTime('sdk_t12345_abcdef01'), null);
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
    tests.push(['a killed run\'s schema and roles older than 6 h are swept by the next setup; a recent one stays', async () => {
        const { createDb } = require('../src/db');
        const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'sdk-sweep-test', max: 1 });
        const stale = runName('sdk', Date.now() - 7 * 3600e3), fresh = runName('sdk', Date.now() - 60e3);
        try {
            for (const n of [stale, fresh]) for (const q of [`CREATE ROLE ${n}_owner LOGIN`, `CREATE ROLE ${n} LOGIN`, `CREATE SCHEMA ${n} AUTHORIZATION ${n}_owner`, `CREATE TABLE ${n}.t (id int)`]) await su.query(q);
            const t = await createTestDb({ migrations: dir, store: 'pg', service: 'sdk' }); await t.close();
            const left = (await su.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [[stale, fresh]])).rows.map((r) => r.nspname);
            assert.deepEqual(left, [fresh], 'the stale one is gone, the recent one stays');
            assert.equal(+(await su.value('SELECT count(*) FROM pg_roles WHERE rolname = ANY($1)', [[stale, `${stale}_owner`]])), 0, 'its roles too');
        } finally {
            for (const q of [`DROP SCHEMA IF EXISTS ${fresh} CASCADE`, `DROP ROLE IF EXISTS ${fresh}`, `DROP ROLE IF EXISTS ${fresh}_owner`]) await su.query(q).catch(() => {});
            await su.close();
        }
    }]);
} else console.log('createTestDb on the containers: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');

run(tests);
