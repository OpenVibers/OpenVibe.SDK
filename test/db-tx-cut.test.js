'use strict';
/**
 * A connection the server cuts while a transaction waits fails that transaction; it never crashes the process.
 * (OpenVibe.AI, 2026-11-14 20:18 UTC: Postgres's idle-in-transaction timeout cut a connection checked out for a
 * transaction, nothing listened on that client, and the unhandled 'error' event exited the service.)
 * Needs PostgreSQL: OV_TEST_PG_DIRECT_URL (scripts/test-services.sh up); skipped without it.
 */
const assert = require('node:assert/strict');
const { createDb, sql } = require('../src/db');

if (!process.env.OV_TEST_PG_DIRECT_URL) { console.log('db-tx-cut: skipped (OV_TEST_PG_DIRECT_URL not set; scripts/test-services.sh up)'); process.exit(0); }

(async () => {
    const crashes = [];
    process.on('uncaughtException', (e) => crashes.push(e));
    const quiet = { warn() {}, info() {}, error() {} };
    const db = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'sdk-test-txcut', max: 2, log: quiet });
    const admin = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'sdk-test-txcut-admin', max: 1, log: quiet });
    let failed = null;
    try {
        await db.tx(async (t) => {
            const pid = await t.value(sql`SELECT pg_backend_pid()`);
            // The cut arrives while the transaction waits on something else, as an idle-in-transaction timeout does.
            await admin.value(sql`SELECT pg_terminate_backend(${pid})`);
            await new Promise((r) => setTimeout(r, 400));
            await t.value(sql`SELECT 1`);
        });
    } catch (err) { failed = err; }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(crashes.length, 0, `the process did not crash (${crashes.map((e) => e.message).join('; ')})`);
    assert.ok(failed, 'the transaction failed');
    assert.equal(await db.value(sql`SELECT 1`), 1, 'the pool answers afterwards');
    assert.equal(await db.tx(async (t) => t.value(sql`SELECT 2`)), 2, 'and a new transaction works on a fresh connection');
    await db.close(); await admin.close();
    console.log('db-tx-cut: a cut connection fails its transaction, never the process');
})().catch((e) => { console.error(e); process.exit(1); });
