'use strict';
/**
 * A migrated database for one test run (ADR-035): what every service's test helper needs, in one place.
 *
 *   const { createTestDb } = require('openvibe-sdk/testing');
 *   const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations') });
 *
 *   store 'pglite' (default): real PostgreSQL in-process, migrated.
 *   store 'pg' (OV_TEST_STORE=pg, or a service's own variable passed as `store`): the production-shaped containers
 *     (scripts/test-services.sh up: OV_TEST_PG_URL through PgBouncer, OV_TEST_PG_DIRECT_URL). The run gets roles and
 *     a schema of its own, shaped as OpenVibe.Host's roles/data/add-service.sh makes them: an owner that migrates on
 *     the direct connection, and a runtime role (DML only, statement_timeout 15 s, lock_timeout 5 s) serving through
 *     PgBouncer. Role setup and teardown take an advisory lock, so parallel runs never race on the catalog ("tuple
 *     concurrently updated"). close() ends the roles' backends (PgBouncer keeps idle server connections) and drops them.
 *   open(): another pooled handle on the same database (a second process).
 *
 *   createTestValkey({ prefix }): the containers' Valkey (OV_TEST_VALKEY_URL) under a prefix no other run uses, or null.
 */
const crypto = require('crypto');

const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const SETUP_LOCK = 735_1_2026;
const pgAvailable = () => !!(process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL);
// A run's schema and roles carry the time they were made (base 36 ms) so a later run can drop what a killed one left: a
// test process ended by a time budget never reaches close(), and 4,382 schemas (364,277 tables, 19 GB) had piled up in
// the containers' database by 2026-10-03.
const ORPHAN_MS = 6 * 3600e3;
const runName = (safe, now = Date.now()) => `${safe}_t${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
/** The time a run's name was made, or null (an older name without one). */
function runTime(name) { const m = /_t([0-9a-z]{8,9})_[0-9a-f]{8}$/.exec(String(name)); if (!m) return null; const t = parseInt(m[1], 36); return t > 1.6e12 && t < 4e12 ? t : null; }
/** Exactly what runName() makes (a service name sanitized to [a-z0-9]{1,12}), so only our own leftovers are ever dropped. */
const RUN_SCHEMA = /^[a-z0-9]{1,12}_t[0-9a-z]{8,9}_[0-9a-f]{8}$/;
const quoteIdent = (id) => `"${String(id).replace(/"/g, '""')}"`;
/** Schemas of runs older than ORPHAN_MS whose roles have no backend: dropped with their roles (under the setup lock). */
async function sweepOrphans(su, { now = Date.now(), maxAge = ORPHAN_MS } = {}) {
    // A name reaches SQL only after matching the full generated shape here (the catalog regex is the same, so a row
    // cannot smuggle one past), and every identifier is quoted.
    const schemas = (await su.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^[a-z0-9]{1,12}_t[0-9a-z]{8,9}_[0-9a-f]{8}$'")).rows.map((r) => r.nspname).filter((n) => RUN_SCHEMA.test(n));
    const old = schemas.filter((n) => { const t = runTime(n); return t && now - t > maxAge; });
    let dropped = 0;
    for (const name of old.slice(0, 200)) {
        const busy = await su.value('SELECT count(*) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, `${name}_owner`]]);
        if (+busy) continue;
        await su.tx(async (t) => {
            await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
            await t.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`);
            for (const r of [name, `${name}_owner`]) { if (await t.value('SELECT count(*) FROM pg_roles WHERE rolname = $1', [r]) > 0) { await t.query(`DROP OWNED BY ${quoteIdent(r)}`); await t.query(`DROP ROLE ${quoteIdent(r)}`); } }
        });
        dropped++;
    }
    return dropped;
}
const valkeyAvailable = () => !!process.env.OV_TEST_VALKEY_URL;

async function createTestDb({ migrations, store = process.env.OV_TEST_STORE || 'pglite', service = 'test', max = 4, log = quiet } = {}) {
    const { createDb } = require('../db');
    if (store !== 'pg') {
        const db = createDb({ pglite: true, service: `${service}-test`, log });
        if (migrations) await db.migrate({ dir: migrations, log });
        return { db, store: 'pglite', url: null, directUrl: null, open: null, close: () => db.close().catch(() => {}) };
    }
    if (!pgAvailable()) throw new Error('store pg needs OV_TEST_PG_URL and OV_TEST_PG_DIRECT_URL (openvibe-sdk scripts/test-services.sh up)');
    const safe = String(service).replace(/[^a-z0-9]/g, '').slice(0, 12) || 'svc';
    const name = runName(safe);
    const owner = `${name}_owner`;
    const pw = crypto.randomBytes(16).toString('hex');
    const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: `${service}-test-admin`, max: 1, log });
    const database = await su.value('SELECT current_database()');
    await sweepOrphans(su).catch(() => {});   // what killed runs left behind; never in the way of this run
    await su.tx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
        for (const stmt of [
            `CREATE ROLE ${owner} LOGIN PASSWORD '${pw}'`,
            `CREATE ROLE ${name} LOGIN PASSWORD '${pw}'`,
            `GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${name}`,
            `CREATE SCHEMA ${name} AUTHORIZATION ${owner}`,
            `ALTER ROLE ${owner} SET search_path = ${name}`,
            `ALTER ROLE ${name} SET search_path = ${name}`,
            `ALTER ROLE ${name} SET statement_timeout = '15s'`,
            `ALTER ROLE ${name} SET lock_timeout = '5s'`,
            `GRANT USAGE ON SCHEMA ${name} TO ${name}`,
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${name}`,
        ]) await t.query(stmt);
    });
    const as = (url, user) => { const u = new URL(url); u.username = user; u.password = pw; return u.toString(); };
    async function drop() {
        try {
            await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, owner]]);
            await su.tx(async (t) => {
                await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
                await t.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
                for (const r of [name, owner]) { await t.query(`DROP OWNED BY ${r}`); await t.query(`DROP ROLE ${r}`); }
            });
        } finally { await su.close(); }
    }
    let db;
    try {
        if (migrations) {
            const ownerDb = createDb({ url: as(process.env.OV_TEST_PG_DIRECT_URL, owner), service: `${service}-test-migrate`, max: 1, log });
            try { await ownerDb.migrate({ dir: migrations, log }); } finally { await ownerDb.close(); }
        }
        db = createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: `${service}-test`, max, log });
    } catch (e) { await drop().catch(() => {}); throw e; }   // a failed setup leaves nothing behind
    return {
        db, store: 'postgresql', schema: name,
        // For a process of its own (a worker the test spawns): DATABASE_URL (through PgBouncer, the service role) and
        // DATABASE_DIRECT_URL (the owner, for its boot's migrate, which finds everything applied).
        url: as(process.env.OV_TEST_PG_URL, name), directUrl: as(process.env.OV_TEST_PG_DIRECT_URL, owner),
        open: (o = {}) => createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: `${service}-test`, max, log, ...o }),
        async close() { await db.close().catch(() => {}); await drop(); },
    };
}

function createTestValkey({ prefix = 'test' } = {}) {
    if (!valkeyAvailable()) return null;
    const { createValkey } = require('../valkey');
    return createValkey({ url: process.env.OV_TEST_VALKEY_URL, prefix: `ov:${prefix}-test:${crypto.randomBytes(4).toString('hex')}:`, log: quiet });
}

module.exports = { createTestDb, createTestValkey, pgAvailable, valkeyAvailable, runName, runTime, sweepOrphans };
