#!/usr/bin/env node
'use strict';
/**
 * The first migration of a better-sqlite3 service (ADR-035), written once: the SCHEMA template literal of its
 * server/db.js through sqlite-schema-to-pg, then the openvibe-publishing stores it opens and the openvibe-sdk inbox
 * and outbox. Run in the service's checkout, after `npm install` of openvibe-publishing ≥ 1.0 and openvibe-sdk ≥ 0.18:
 *
 *   node gen-migration.js <Name> [--publishing revisions:blog_post,citations:blog_post,index-hooks:blog,seo:blog_entity,…]
 *                               [--no-inbox] [--outbox-table t] [--inbox-table t] [--no-outbox] [--ensure a.js,b.js]
 *                               [--from server/store.js]   (the module holding SCHEMA; default server/db.js)
 *                               [--open "require('./server/db').openDb(':memory:')"]
 *     → migrations/0001_initial.sql
 *
 * --open: the schema as the service's own boot code leaves a fresh SQLite database (SCHEMA, then every migrate() ALTER
 * and seed, then the --ensure modules run on it), for a service whose migrate() changed tables after SCHEMA. Run it
 * before converting any code (the working copy is the SQLite release). Tables come out in dependency order, one column
 * per line; the rows the boot seeded become INSERTs; SQLite text timestamps (DATETIME, CURRENT_TIMESTAMP) bring
 * SQLITE_DATE_FUNCTIONS along.
 *
 * It lists every `rowid` the server code still orders by: those tables need a `seq bigint GENERATED ALWAYS AS
 * IDENTITY UNIQUE` column (a person adds it; see docs/migrating-to-postgresql.md §7).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { toPg, SQLITE_DATE_FUNCTIONS, PG_ONLY_RESERVED } = require('./sqlite-schema-to-pg');

const args = process.argv.slice(2);
const Name = args[0];
if (!Name) { console.error('usage: gen-migration.js <Name> [--publishing store:prefix,…] [--no-inbox]'); process.exit(2); }
const pi = args.indexOf('--publishing');
const pubs = pi >= 0 ? args[pi + 1].split(',').map((x) => x.split(':')) : [];
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));

const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const ensureList = opt('--ensure', '') ? opt('--ensure', '').split(',') : [];

/** A fresh SQLite database opened by the service's code → PostgreSQL DDL (tables in dependency order) and seed rows. */
function fromOpenedDb(expr) {
    const { createRequire } = require('module');
    const creq = createRequire(path.resolve('package.json'));
    const sdb = new Function('require', `return (${expr});`)(creq);
    for (const f of ensureList) creq(path.resolve(f)).ensureSchema(sdb);
    const stripComments = (sql) => {
        let o = ''; let q = null;
        for (let i = 0; i < sql.length; i++) {
            const c = sql[i];
            if (q) { o += c; if (c === q) q = null; continue; }
            if (c === "'" || c === '"') { q = c; o += c; continue; }
            if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; o += '\n'; continue; }
            o += c;
        }
        return o;
    };
    const splitTop = (body) => {
        const parts = []; let depth = 0; let q = null; let cur = '';
        for (const c of body) {
            if (q) { cur += c; if (c === q) q = null; continue; }
            if (c === "'" || c === '"') { q = c; cur += c; continue; }
            if (c === '(') depth++;
            if (c === ')') depth--;
            if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
            cur += c;
        }
        if (cur.trim()) parts.push(cur.trim());
        return parts;
    };
    const objs = sdb.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tables = objs.filter((o) => o.type === 'table' && !/CREATE VIRTUAL/i.test(o.sql));
    const byName = new Map(tables.map((t) => [t.name, t]));
    const order = []; const done = new Set();
    const visit = (t, stack) => {
        if (done.has(t.name) || stack.has(t.name)) return;
        stack.add(t.name);
        for (const m of t.sql.matchAll(/REFERENCES\s+"?(\w+)"?/gi)) { const d = byName.get(m[1]); if (d && d.name !== t.name) visit(d, stack); }
        done.add(t.name); order.push(t);
    };
    for (const t of tables) visit(t, new Set());
    let ddl = '';
    const tsDefault = new Set(); const pk = new Map();
    for (const t of order) {
        const sql = stripComments(t.sql);
        const i = sql.indexOf('('); const j = sql.lastIndexOf(')');
        const cols = splitTop(sql.slice(i + 1, j)).map((x) => x.replace(/\s+/g, ' '));
        for (const c of cols) {
            const m = /^"?(\w+)"? /.exec(c);
            if (!m) continue;
            if (/DEFAULT (CURRENT_TIMESTAMP|\((datetime|strftime)\()/i.test(c)) tsDefault.add(`${t.name}.${m[1]}`);
            if (/^"?\w+"? INTEGER PRIMARY KEY/i.test(c)) pk.set(t.name, { col: m[1], always: /AUTOINCREMENT/i.test(c) });
        }
        const tail = sql.slice(j + 1).trim();
        ddl += `CREATE TABLE ${t.name} (\n    ${cols.join(',\n    ')}\n)${tail ? ` ${tail}` : ''};\n\n`;
    }
    for (const o of objs) if (o.type === 'index') ddl += `${stripComments(o.sql).replace(/\s+/g, ' ').trim()};\n`;
    for (const o of objs) if (o.type === 'trigger') ddl += `\n${o.sql.trim()};\n`;
    for (const o of objs) if (o.type === 'view') ddl += `\n${o.sql.trim()};\n`;
    let out = toPg(ddl);
    // Seed rows the boot wrote (spaces, categories, …); timestamp defaults fill themselves in.
    const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v)
        : Buffer.isBuffer(v) ? `'\\x${v.toString('hex')}'` : `'${String(v).replace(/'/g, "''")}'`);
    let seeds = '';
    for (const t of order) {
        const rows = sdb.prepare(`SELECT * FROM "${t.name}"`).all();
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]).filter((c) => !tsDefault.has(`${t.name}.${c}`));
        const k = pk.get(t.name);
        const q = (c) => (PG_ONLY_RESERVED.includes(c.toLowerCase()) ? `"${c}"` : c);
        seeds += `INSERT INTO ${t.name} (${cols.map(q).join(', ')})${k && k.always && cols.includes(k.col) ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES\n`
            + `${rows.map((r) => `    (${cols.map((c) => lit(r[c])).join(', ')})`).join(',\n')};\n`;
        if (k && cols.includes(k.col)) seeds += `SELECT setval(pg_get_serial_sequence('${t.name}', '${k.col}'), (SELECT MAX(${k.col}) FROM ${t.name}));\n`;
    }
    if (seeds) out += `\n-- Rows the SQLite boot seeded\n${seeds}`;
    if (/ov_now\(\)|ov_now_iso\(\)/.test(out)) out = `${SQLITE_DATE_FUNCTIONS}\n${out}`;
    try { sdb.close(); } catch { /* in-memory */ }
    return out;
}

// The schema as the SQLite release ran it: server/db.js at HEAD (the conversion edits the working copy). A literal with
// ${…} interpolations is evaluated by loading that file and reading its SCHEMA export.
const dbFile = (() => { const i = args.indexOf('--from'); return i >= 0 ? args[i + 1] : 'server/db.js'; })();
const openExpr = opt('--open', null);
const src = openExpr ? '' : execFileSync('git', ['show', `HEAD:${dbFile}`], { encoding: 'utf8' });
const m = openExpr ? [null, ''] : /const SCHEMA = `([\s\S]*?)`;/.exec(src);
if (!m) { console.error(`${dbFile} (HEAD) has no const SCHEMA = \`…\`;`); process.exit(1); }
if (!openExpr && m[1].includes('${')) {
    const tmp = path.resolve(path.dirname(dbFile), '.db-head-schema.js');
    fs.writeFileSync(tmp, src);
    try {
        const schema = require(tmp).SCHEMA;
        if (typeof schema !== 'string') throw new Error('it does not export SCHEMA');
        m[1] = schema;
    } catch (err) { console.error(`the SCHEMA literal has interpolations and could not be evaluated: ${err.message}`); process.exit(1); } finally { fs.unlinkSync(tmp); }
}
let out = `-- phase: expand
-- OpenVibe.${Name} on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on ${new Date().toISOString().slice(0, 10)}; never edited after it runs.
${(openExpr ? fromOpenedDb(openExpr) : toPg(m[1])).replace(/\n{3,}/g, '\n\n')}`;
// --ensure a.js,b.js: modules whose ensureSchema(db) created more tables at boot; their SQL is captured and converted too.
if (!openExpr) {
    const i = args.indexOf('--ensure');
    if (i >= 0) {
        for (const f of args[i + 1].split(',')) {
            const sqls = [];
            const fake = { exec: (q) => sqls.push(q), prepare: () => ({ run() {}, get() {}, all: () => [] }), pragma() {}, function() {} };
            req(path.resolve(f)).ensureSchema(fake);
            out += `\n-- ${f} ensureSchema()\n${toPg(sqls.join('\n').replace(/^ {4}/gm, '')).trim()}\n`;
        }
    }
}
const SCHEMA_OF = { 'index-hooks': (x, p) => x.sequencerSchema(p), seo: (x, p) => x.redirectsSchema(p) };
for (const [store, prefix] of pubs) {
    const mod = req(`openvibe-publishing/${store}`);
    out += `\n-- openvibe-publishing/${store} (prefix ${prefix})\n${(SCHEMA_OF[store] ? SCHEMA_OF[store](mod, prefix) : mod.schema(prefix)).trim()}\n`;
}
const ev = req('openvibe-sdk/events');
const inboxTable = opt('--inbox-table', 'idempotency_receipts');
const outboxTable = opt('--outbox-table', 'event_outbox');
if (!args.includes('--no-inbox')) out += `\n-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled\n${ev.inboxSchema(inboxTable).trim()}\n`;
if (!args.includes('--no-outbox')) out += `\n-- openvibe-sdk/events PostgreSQL outbox\n${ev.outboxSchema(outboxTable).trim()}\n`;
// SQLite's own copies of the tables above (created by the packages at boot) would be defined twice.
for (const t of [outboxTable, inboxTable]) {
    const re = new RegExp(`\\nCREATE TABLE ${t} \\([\\s\\S]*?\\n\\);\\n`, 'g');
    if ((out.match(re) || []).length && out.includes(`CREATE TABLE IF NOT EXISTS ${t}`)) out = out.replace(re, '\n');
}
fs.mkdirSync('migrations', { recursive: true });
fs.writeFileSync(path.join('migrations', '0001_initial.sql'), out);
console.log(`migrations/0001_initial.sql: ${(out.match(/CREATE TABLE/g) || []).length} tables`);
try {
    const hits = execFileSync('git', ['grep', '-n', 'rowid', '--', 'server', 'scripts'], { encoding: 'utf8' }).trim();
    if (hits) console.log(`rowid still used (add a seq identity column to these tables and order by it):\n${hits}`);
} catch { /* no rowid */ }
