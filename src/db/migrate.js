'use strict';
/**
 * Versioned migrations for openvibe-sdk/db (ADR-035, ADR-028 expand/migrate/contract).
 *
 * A migrations directory holds files named `NNNN_description.sql` (NNNN: four or more digits, applied in order).
 * The first lines are headers:
 *
 *   -- phase: expand | migrate | contract        (required)
 *   -- after: 0012                                (contract only: the expand migration it completes)
 *   -- no-transaction                             (for CREATE INDEX CONCURRENTLY and the like)
 *
 * Each migration runs once, in a transaction unless it says otherwise, and is recorded in `ov_migrations`
 * with its checksum; editing an applied file is refused. Runs are serialised by an advisory lock, so several
 * processes starting together apply each migration once. A contract migration is refused until the expand it
 * names has been applied for `windowDays` (default 7, the N-1 window of ADR-016), so a rollback to the previous
 * release still finds what it expects; a held contract holds every later migration too (order is kept). A fresh
 * database (no row in ov_migrations when the run starts: a new install, a test database, a restore drill into an
 * empty schema) applies its contracts at once: no previous release can be running against it, and holding them
 * would stop every fresh database at its first contract for the length of the window, with everything after it
 * untested. Run it with the owner role (DATABASE_DIRECT_URL): the runtime role
 * behind PgBouncer may not change the schema, and advisory locks need a session.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_RE = /^(\d{4,})_([a-z0-9_-]+)\.sql$/;
const LOCK_KEY = 71_335_035;   // one advisory lock id for every service's migrations (ADR-035)

function parse(dir) {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const seen = new Set();
    return files.map((f) => {
        const m = FILE_RE.exec(f);
        if (!m) throw new Error(`migrate: ${f} is not named NNNN_description.sql`);
        if (seen.has(m[1])) throw new Error(`migrate: two migrations numbered ${m[1]}`);
        seen.add(m[1]);
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const header = text.split('\n').slice(0, 12).join('\n');
        const phase = (/^--\s*phase:\s*(expand|migrate|contract)\s*$/m.exec(header) || [])[1];
        if (!phase) throw new Error(`migrate: ${f} has no "-- phase: expand|migrate|contract" header`);
        const after = (/^--\s*after:\s*(\d{4,})\s*$/m.exec(header) || [])[1] || null;
        if (phase === 'contract' && !after) throw new Error(`migrate: ${f} is a contract migration and must name its expand ("-- after: NNNN")`);
        return {
            id: m[1], name: m[2], file: f, phase, after, text,
            transaction: !/^--\s*no-transaction\s*$/m.test(header),
            checksum: crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'),
        };
    });
}

/**
 * @param {object} o
 * @param {object} o.db         a createDb() handle with schema rights (owner role, DATABASE_DIRECT_URL)
 * @param {string} o.dir        the migrations directory
 * @param {number} [o.windowDays]  N-1 window before a contract migration may run (default 7)
 * @param {boolean} [o.dryRun]  report only
 * @param {() => number} [o.now]
 * → { applied: [{ id, name, phase, ms }], pending: [...], held: [{ id, reason }] }
 */
async function migrate({ db, dir, windowDays = 7, dryRun = false, now = () => Date.now(), log = console }) {
    const all = parse(dir);
    const out = { applied: [], pending: [], held: [] };
    const run = async (t) => {
        await t.query(`CREATE TABLE IF NOT EXISTS ov_migrations (
            id text PRIMARY KEY, name text NOT NULL, phase text NOT NULL CHECK (phase IN ('expand','migrate','contract')),
            checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0)`);
        const done = new Map((await t.many('SELECT id, checksum, applied_at FROM ov_migrations')).map((r) => [r.id, r]));
        // A database with no applied migration has no previous release to protect: its contracts apply at once.
        const fresh = done.size === 0;
        for (const m of all) {
            const prev = done.get(m.id);
            if (prev) {
                if (prev.checksum !== m.checksum) throw new Error(`migrate: ${m.file} changed after it was applied (write a new migration instead)`);
                continue;
            }
            const later = [...done.keys()].find((id) => id > m.id);
            if (later) throw new Error(`migrate: ${m.file} is older than applied migration ${later}; number new migrations after the last one`);
            if (m.phase === 'contract' && !fresh) {
                const exp = done.get(m.after);
                const ageDays = exp ? (now() - Date.parse(exp.applied_at)) / 86400000 : -1;
                if (!exp || ageDays < windowDays) {
                    out.held.push({ id: m.id, reason: exp ? `expand ${m.after} applied ${ageDays.toFixed(1)} days ago; the N-1 window is ${windowDays}` : `expand ${m.after} is not applied` });
                    break;   // later migrations wait too: order is kept
                }
            }
            out.pending.push({ id: m.id, name: m.name, phase: m.phase });
            if (dryRun) continue;
            const t0 = Date.now();
            if (m.transaction) {
                await t.query('BEGIN');
                try {
                    await t.query(m.text);
                    await t.query('INSERT INTO ov_migrations (id, name, phase, checksum, duration_ms) VALUES ($1, $2, $3, $4, $5)', [m.id, m.name, m.phase, m.checksum, Date.now() - t0]);
                    await t.query('COMMIT');
                } catch (err) { await t.query('ROLLBACK').catch(() => {}); throw new Error(`migrate: ${m.file} failed: ${err.message}`); }
            } else {
                try { await t.query(m.text); } catch (err) { throw new Error(`migrate: ${m.file} (no transaction) failed: ${err.message}`); }
                await t.query('INSERT INTO ov_migrations (id, name, phase, checksum, duration_ms) VALUES ($1, $2, $3, $4, $5)', [m.id, m.name, m.phase, m.checksum, Date.now() - t0]);
            }
            done.set(m.id, { id: m.id, checksum: m.checksum, applied_at: new Date().toISOString() });
            out.applied.push({ id: m.id, name: m.name, phase: m.phase, ms: Date.now() - t0 });
            log.log ? log.log(`[db] migration ${m.file} (${m.phase}) applied in ${Date.now() - t0} ms`) : null;
        }
    };
    // One session for the whole run: the advisory lock and the migrations share it.
    const adapter = db._adapter;
    const conn = await adapter.acquire();
    const session = {
        query: (text, values) => adapter.run(conn, text, values || []),
        many: async (text, values) => (await adapter.run(conn, text, values || [])).rows,
    };
    try {
        await session.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        try { await run(session); } finally { await session.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}); }
    } finally { adapter.release(conn); }
    return out;
}

module.exports = { migrate, parse };
