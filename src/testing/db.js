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
 *   Snapshot (PGlite): a fresh PGlite plus the whole migration run costs seconds in every test process. The first
 *   process to need a database builds it (boot, migrate, the optional `seed(db)` hook), dumps its data directory to
 *   os.tmpdir()/openvibe-test-snapshots (OV_TEST_SNAPSHOT_DIR), and every later one loads that file instead. The key
 *   is the migrations' file names and contents, the SDK and @electric-sql/pglite versions and `seedKey` (else the
 *   seed function's source). Parallel processes build it once under a lock file (the others wait up to 60 s, then
 *   migrate on their own); a file that does not load is deleted and rebuilt. A hit refreshes `ov_migrations.applied_at`
 *   so an ADR-028 contract migration stays held exactly as it would on a fresh migrate. OV_TEST_SNAPSHOT=0 turns it off.
 *   The result says which happened (`snapshot`: 'hit' | 'built' | 'off') and how long setup took (`setupMs`).
 *
 *   createTestValkey({ prefix }): the containers' Valkey (OV_TEST_VALKEY_URL) under a prefix no other run uses, or null.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const SETUP_LOCK = 735_1_2026;
const pgAvailable = () => !!(process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL);
// A leased run's schema and roles carry the time they were made (base 36 ms). The lease connection stays open even
// when the query pool goes idle; a killed process releases it so a later run can safely remove what it left behind.
const ORPHAN_MS = 6 * 3600e3;
const runName = (safe, now = Date.now()) => `${safe}_t${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}_l`;
/** The time a run's name was made, or null (an older name without one). */
function runTime(name) { const m = /_t([0-9a-z]{8,9})_[0-9a-f]{8}_l$/.exec(String(name)); if (!m) return null; const t = parseInt(m[1], 36); return t > 1.6e12 && t < 4e12 ? t : null; }
const leaseKey = (name) => crypto.createHash('sha256').update(`openvibe-test-db:${name}`).digest().readBigInt64BE(0).toString();
/** Exactly what runName() makes (the service name sanitized to [a-z0-9]{1,12}): only this run shape is ever dropped. */
const RUN_SCHEMA = /^[a-z0-9]{1,12}_t[0-9a-z]{8,9}_[0-9a-f]{8}_l$/;
const isRunSchema = (name) => RUN_SCHEMA.test(String(name));
const quoteIdent = (id) => `"${String(id).replace(/"/g, '""')}"`;
/** Sweep only leased runs: older naming formats have no reliable end-of-run signal. A catalog name reaches SQL only
 *  after matching the whole generated shape, and quoted. */
async function sweepOrphans(su, { now = Date.now(), maxAge = ORPHAN_MS } = {}) {
    const schemas = (await su.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^[a-z0-9]{1,12}_t[0-9a-z]{8,9}_[0-9a-f]{8}_l$'")).rows.map((r) => r.nspname).filter(isRunSchema);
    const old = schemas.filter((n) => { const t = runTime(n); return t && now - t > maxAge; });
    let dropped = 0;
    for (const name of old.slice(0, 200)) {
        const removed = await su.tx(async (t) => {
            await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
            if (!await t.value('SELECT pg_try_advisory_xact_lock($1::bigint)', [leaseKey(name)])) return false;
            const busy = await t.value('SELECT count(*) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, `${name}_owner`]]);
            if (+busy) return false;
            await t.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`);
            for (const r of [name, `${name}_owner`]) { if (await t.value('SELECT count(*) FROM pg_roles WHERE rolname = $1', [r]) > 0) { await t.query(`DROP OWNED BY ${quoteIdent(r)}`); await t.query(`DROP ROLE ${quoteIdent(r)}`); } }
            return true;
        });
        if (removed) dropped++;
    }
    return dropped;
}
const valkeyAvailable = () => !!process.env.OV_TEST_VALKEY_URL;

// ── PGlite snapshot ────────────────────────────────────────────────────────────────────────
const SNAPSHOT_WAIT_MS = 60_000;          // a waiter migrates on its own after this
const SNAPSHOT_LOCK_STALE_MS = 10 * 60e3; // a lock this old is a dead builder's
const SNAPSHOT_KEEP_MS = 7 * 86400e3;     // snapshots unused this long are removed when another is built
const snapshotsOn = () => !/^(0|false|off|no)$/i.test(String(process.env.OV_TEST_SNAPSHOT || '').trim());
const snapshotDir = () => process.env.OV_TEST_SNAPSHOT_DIR || path.join(os.tmpdir(), 'openvibe-test-snapshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pgliteVersion() {
    try {
        let d = path.dirname(require.resolve('@electric-sql/pglite'));
        for (let i = 0; i < 5; i++, d = path.dirname(d)) {
            const f = path.join(d, 'package.json');
            if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.name === '@electric-sql/pglite') return j.version; }
        }
    } catch { /* not installed: createDb says so */ }
    return 'unknown';
}

/** The snapshot's name: what a migrated (and seeded) database depends on. */
function snapshotKey({ migrations, seed, seedKey } = {}) {
    const h = crypto.createHash('sha256');
    h.update(`openvibe-test-snapshot:1\0sdk ${require('../../package.json').version}\0pglite ${pgliteVersion()}\0`);
    if (migrations && fs.existsSync(migrations)) {
        for (const f of fs.readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(migrations, f))).update('\0');
    }
    h.update(`seed\0${seed ? (seedKey != null ? `key:${seedKey}` : `fn:${seed.toString()}`) : 'none'}`);
    return h.digest('hex').slice(0, 32);
}

const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const sameFile = (a, b) => !!(a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** Take the build lock (a file made exclusively), or break it when its builder is gone. */
function takeLock(lock) {
    try { fs.writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = statOf(lock);
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(lock, 'utf8'), 10) || 0; } catch { /* gone already */ }
    let alive = true;
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
    if (!alive || (st && Date.now() - st.mtimeMs > SNAPSHOT_LOCK_STALE_MS)) fs.rmSync(lock, { force: true });
    return false;
}

function pruneSnapshots(dir, keep) {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (p === keep) continue;
        const st = statOf(p);
        if (!st) continue;
        if ((f.endsWith('.pgdata') && now - st.mtimeMs > SNAPSHOT_KEEP_MS) || (f.endsWith('.tmp') && now - st.mtimeMs > 3600e3)) fs.rmSync(p, { force: true });
    }
}

async function pgliteTestDb({ migrations, seed, seedKey, service, log }) {
    const { createDb } = require('../db');
    const t0 = Date.now();
    const handle = (db, snapshot) => ({
        db, store: 'pglite', snapshot, setupMs: Date.now() - t0, url: null, directUrl: null, open: null, close: () => db.close().catch(() => {}),
    });
    const build = async () => {
        const db = createDb({ pglite: true, service: `${service}-test`, log });
        try {
            if (migrations) await db.migrate({ dir: migrations, log });
            if (seed) await seed(db);
        } catch (e) { await db.close().catch(() => {}); throw e; }
        return db;
    };
    if (!snapshotsOn()) return handle(await build(), 'off');
    const dir = snapshotDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log.warn(`[test-db] snapshot directory ${dir}: ${e.message}; migrating instead`); return handle(await build(), 'off'); }
    const file = path.join(dir, `${snapshotKey({ migrations, seed, seedKey })}.pgdata`);
    const lock = `${file}.lock`;
    const deadline = Date.now() + SNAPSHOT_WAIT_MS;
    let bad = null;   // the snapshot file that failed to load: rebuilt, never loaded again
    for (;;) {
        const st = statOf(file);
        if (st && !sameFile(st, bad)) {
            let inst = null;
            try {
                const { PGlite } = require('@electric-sql/pglite');
                inst = new PGlite({ loadDataDir: new Blob([fs.readFileSync(file)]) });
                await inst.waitReady;
                const db = createDb({ pglite: inst, service: `${service}-test`, log });
                if (migrations) {
                    // The snapshot froze ov_migrations.applied_at at build time. An ADR-028 contract migration is
                    // held until its expand has been applied for windowDays, so a reused snapshot would let it run
                    // ~7 days after it was built, while a fresh migrate holds it. Refresh the ages so the loaded
                    // database looks freshly migrated, as it did before snapshots.
                    await db.query('UPDATE ov_migrations SET applied_at = now()').catch(() => {});
                    // The key covers the migrations, so this is a check: migrate only if the snapshot is behind.
                    const applied = new Set((await db.many('SELECT id FROM ov_migrations').catch(() => [])).map((r) => r.id));
                    if (require('../db/migrate').parse(migrations).some((m) => !applied.has(m.id))) await db.migrate({ dir: migrations, log });
                }
                try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* kept a little less long */ }
                return handle(db, 'hit');
            } catch (e) {
                if (inst) await inst.close().catch(() => {});
                log.warn(`[test-db] snapshot ${path.basename(file)} did not load (${e.message}); rebuilding it`);
                bad = st;
                continue;
            }
        }
        if (takeLock(lock)) {
            let db;
            try {
                const now = statOf(file);
                if (now && !sameFile(now, bad)) continue;   // another process finished it meanwhile
                if (now) fs.rmSync(file, { force: true });
                db = await build();
                const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
                try {
                    const blob = await db._adapter.instance.dumpDataDir('none');
                    fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
                    fs.renameSync(tmp, file);
                    pruneSnapshots(dir, file);
                } catch (e) { fs.rmSync(tmp, { force: true }); log.warn(`[test-db] snapshot not saved: ${e.message}`); }
            } finally { fs.rmSync(lock, { force: true }); }
            return handle(db, 'built');
        }
        if (Date.now() > deadline) { log.warn(`[test-db] snapshot still being built after ${SNAPSHOT_WAIT_MS / 1000} s; migrating instead`); return handle(await build(), 'off'); }
        await sleep(100);
    }
}

async function createTestDb({ migrations, seed, seedKey, store = process.env.OV_TEST_STORE || 'pglite', service = 'test', max = 4, log = quiet } = {}) {
    const { createDb } = require('../db');
    if (seed != null && typeof seed !== 'function') throw new TypeError('createTestDb: seed must be an async function (db) => {}');
    if (store !== 'pg') return pgliteTestDb({ migrations, seed, seedKey, service, log });
    const t0 = Date.now();
    if (!pgAvailable()) throw new Error('store pg needs OV_TEST_PG_URL and OV_TEST_PG_DIRECT_URL (openvibe-sdk scripts/test-services.sh up)');
    const safe = String(service).replace(/[^a-z0-9]/g, '').slice(0, 12) || 'svc';
    const name = runName(safe);
    const owner = `${name}_owner`;
    const pw = crypto.randomBytes(16).toString('hex');
    const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: `${service}-test-admin`, max: 1, log });
    const { Client } = require('pg');
    const lease = new Client({ connectionString: process.env.OV_TEST_PG_DIRECT_URL, application_name: `${service}-test-lease`, keepAlive: true });
    let releasingLease = false;
    try {
        await lease.connect();
        // The lease socket must not keep the process alive: a test file that ends without process.exit() would otherwise
        // never exit (0.26-0.31.0). It still holds the advisory lock for as long as the process lives.
        if (lease.connection && lease.connection.stream && typeof lease.connection.stream.unref === 'function') lease.connection.stream.unref();
        await lease.query('SELECT pg_advisory_lock($1::bigint)', [leaseKey(name)]);
        lease.on('end', () => { if (!releasingLease) throw new Error(`test database lease lost for ${name}`); });
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
    } catch (e) { releasingLease = true; await lease.end().catch(() => {}); await su.close().catch(() => {}); throw e; }
    const as = (url, user) => { const u = new URL(url); u.username = user; u.password = pw; return u.toString(); };
    let db;
    async function drop() {
        try {
            await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, owner]]);
            await su.tx(async (t) => {
                await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
                await t.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
                for (const r of [name, owner]) { await t.query(`DROP OWNED BY ${r}`); await t.query(`DROP ROLE ${r}`); }
            });
        } finally { releasingLease = true; await lease.end().catch(() => {}); await su.close(); }
    }
    try {
        if (migrations) {
            const ownerDb = createDb({ url: as(process.env.OV_TEST_PG_DIRECT_URL, owner), service: `${service}-test-migrate`, max: 1, log });
            try { await ownerDb.migrate({ dir: migrations, log }); } finally { await ownerDb.close(); }
        }
        db = createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: `${service}-test`, max, log });
        if (seed) {
            // On PGlite the seed runs on the migrated handle (the owner). The runtime role here is DML-only
            // (no TRUNCATE, ALTER SEQUENCE or DDL), so run the pg seed as the owner too: both stores behave alike.
            const seedDb = createDb({ url: as(process.env.OV_TEST_PG_DIRECT_URL, owner), service: `${service}-test-seed`, max: 1, log });
            try { await seed(seedDb); } finally { await seedDb.close(); }
        }
    } catch (e) { if (db) await db.close().catch(() => {}); await drop().catch(() => {}); throw e; }   // a failed setup leaves nothing behind
    return {
        db, store: 'postgresql', schema: name, snapshot: 'off', setupMs: Date.now() - t0,
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

module.exports = { createTestDb, createTestValkey, pgAvailable, valkeyAvailable, runName, runTime, isRunSchema, leaseKey, sweepOrphans, snapshotKey, snapshotDir };
