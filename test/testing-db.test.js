'use strict';
/** openvibe-sdk/testing createTestDb: a migrated PGlite database; on the containers, parallel setups do not race. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./helpers');
const { createTestDb, pgAvailable } = require('../src/testing');

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
} else console.log('createTestDb on the containers: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');

run(tests);
