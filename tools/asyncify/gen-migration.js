#!/usr/bin/env node
'use strict';
/**
 * The first migration of a better-sqlite3 service (ADR-035), written once: the SCHEMA template literal of its
 * server/db.js through sqlite-schema-to-pg, then the openvibe-publishing stores it opens and the openvibe-sdk inbox
 * and outbox. Run in the service's checkout, after `npm install` of openvibe-publishing ≥ 1.0 and openvibe-sdk ≥ 0.18:
 *
 *   node gen-migration.js <Name> [--publishing revisions:blog_post,citations:blog_post,index-hooks:blog,seo:blog_entity,…]
 *                               [--no-inbox] [--outbox-table t] [--inbox-table t] [--no-outbox] [--ensure a.js,b.js]
 *     → migrations/0001_initial.sql
 *
 * It lists every `rowid` the server code still orders by: those tables need a `seq bigint GENERATED ALWAYS AS
 * IDENTITY UNIQUE` column (a person adds it; see docs/migrating-to-postgresql.md §7).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { toPg } = require('./sqlite-schema-to-pg');

const args = process.argv.slice(2);
const Name = args[0];
if (!Name) { console.error('usage: gen-migration.js <Name> [--publishing store:prefix,…] [--no-inbox]'); process.exit(2); }
const pi = args.indexOf('--publishing');
const pubs = pi >= 0 ? args[pi + 1].split(',').map((x) => x.split(':')) : [];
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));

// The schema as the SQLite release ran it: server/db.js at HEAD (the conversion edits the working copy). A literal with
// ${…} interpolations is evaluated by loading that file and reading its SCHEMA export.
const src = execFileSync('git', ['show', 'HEAD:server/db.js'], { encoding: 'utf8' });
const m = /const SCHEMA = `([\s\S]*?)`;/.exec(src);
if (!m) { console.error('server/db.js (HEAD) has no const SCHEMA = `…`;'); process.exit(1); }
if (m[1].includes('${')) {
    const tmp = path.resolve('server', '.db-head-schema.js');
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
${toPg(m[1]).replace(/\n{3,}/g, '\n\n')}`;
// --ensure a.js,b.js: modules whose ensureSchema(db) created more tables at boot; their SQL is captured and converted too.
{
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
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
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
