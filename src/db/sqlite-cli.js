'use strict';
/**
 * The one-time move of a service's SQLite database into its PostgreSQL schema (ADR-035; the procedure is
 * docs/migrating-to-postgresql.md, section 6), shared by every service's scripts/migrate-to-postgres.js:
 *
 *   const { runSqliteMigration } = require('openvibe-sdk/db');
 *   runSqliteMigration({ service: 'wiki', sqlite: config.dbPath, directUrl: config.db.directUrl,
 *       migrations: MIGRATIONS, tables: { new_name: { from: 'old_name' } } }).then((code) => process.exit(code));
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 *   1. applies the migrations as the owner (directUrl, a direct connection); --pglite: an in-memory PostgreSQL
 *      instead (a rehearsal with nothing to set up; the report is all it leaves);
 *   2. copies every table with importSqlite (batched, parents first, identities kept and sequences advanced)
 *      into emptied tables (truncate: a rehearsal can be repeated);
 *   3. makes text PostgreSQL refuses storable, and reports it: a NUL character is dropped and an unpaired
 *      surrogate becomes U+FFFD, in text and inside JSON values alike (SQLite took both);
 *   4. verifies each table's row count and a checksum of every row on both sides, prints the report, and
 *      answers 1 unless report.ok. The SQLite file is opened read-only: nothing in it changes.
 * `tables` is importSqlite's per-table options (from, dropColumns, where, map), merged with the cleaning.
 */
const path = require('path');

const cleanText = (v) => v.toWellFormed().replace(/\u0000/g, '');
function cleanJson(v) {
    if (typeof v === 'string') return cleanText(v);
    if (Array.isArray(v)) return v.map(cleanJson);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), cleanJson(x)]));
    return v;
}

/** importSqlite's `tables` for the target schema: `tables`, plus a map per table making text storable. */
async function cleaningOptions(db, tables = {}) {
    const cols = await db.many(`SELECT table_name, column_name, udt_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name <> 'ov_migrations' AND udt_name IN ('text', 'varchar', 'json', 'jsonb')`);
    const byTable = new Map();
    for (const c of cols) { if (!byTable.has(c.table_name)) byTable.set(c.table_name, []); byTable.get(c.table_name).push(c); }
    const cleaned = new Map();
    const note = (t, c, v) => { const k = `${t}.${c}`; if (!cleaned.has(k)) cleaned.set(k, new Set()); cleaned.get(k).add(v); };
    const out = { ...tables };
    for (const [table, list] of byTable) {
        const base = tables[table] || {};
        out[table] = {
            ...base,
            map(row) {
                const r = base.map ? base.map(row) : row;
                if (!r) return r;
                for (const { column_name: c, udt_name: udt } of list) {
                    const v = r[c];
                    if (typeof v !== 'string') continue;
                    if (udt === 'json' || udt === 'jsonb') {
                        let parsed;
                        try { parsed = JSON.parse(v); } catch { continue; }   // left for the importer to report
                        const fixed = JSON.stringify(cleanJson(parsed));
                        if (fixed !== JSON.stringify(parsed)) { note(table, c, v); r[c] = fixed; }
                    } else {
                        const fixed = cleanText(v);
                        if (fixed !== v) { note(table, c, v); r[c] = fixed; }
                    }
                }
                return r;
            },
        };
    }
    return { tables: out, cleaned: () => [...cleaned].map(([column, values]) => ({ column, values: values.size })) };
}

async function runSqliteMigration({ service, sqlite, directUrl, migrations, tables = {}, skipSource = [], argv = process.argv.slice(2), out = console.log } = {}) {
    const { createDb, importSqlite } = require('./index');
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const flag = (name) => argv.includes(`--${name}`);
    const file = path.resolve(opt('sqlite') || sqlite || '');
    const quiet = { log() {}, warn: console.warn, error: console.error };
    let owner;
    if (flag('pglite')) {
        owner = createDb({ pglite: true, service: `${service}-import`, log: quiet });
    } else {
        if (!directUrl) throw new Error('DATABASE_DIRECT_URL is not set: the import runs as the owner on a direct connection');
        owner = createDb({ url: directUrl, service: `${service}-import`, max: 2, log: quiet });
    }
    try {
        await owner.migrate({ dir: migrations, log: quiet });
        const t0 = Date.now();
        const options = await cleaningOptions(owner, tables);
        const report = await importSqlite({ sqlite: file, db: owner, truncate: true, tables: options.tables, skipSource, log: quiet });
        const cleaned = options.cleaned();
        if (flag('json')) out(JSON.stringify({ sqlite: file, into: owner.store, ...report, cleaned }, null, 2));
        else {
            out(`import ${file} → ${owner.store} (${Date.now() - t0} ms): ${report.ok ? 'OK' : 'PROBLEMS'}`);
            for (const t of report.tables) out(`  ${t.table.padEnd(30)} ${String(t.rows).padStart(8)} rows  ${t.checksum || '-'}${t.source !== t.table ? `  (from ${t.source})` : ''}`);
            for (const c of cleaned) out(`  cleaned: ${c.column}: ${c.values} value(s) with a NUL or an unpaired surrogate`);
            for (const p of report.problems) out(`  problem: ${p.table}: ${p.problem}`);
        }
        return report.ok ? 0 : 1;
    } finally {
        await owner.close();
    }
}

module.exports = { runSqliteMigration, cleaningOptions, cleanText, cleanJson };
