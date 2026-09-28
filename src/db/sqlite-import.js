'use strict';
/**
 * The one-time move of a service's SQLite data into its PostgreSQL schema (ADR-035 amendment, WS-X2 step 4).
 *
 *   const { importSqlite } = require('openvibe-sdk/db');
 *   const report = await importSqlite({ sqlite: '/opt/…/wiki.db', db: ownerDb, truncate: true });
 *   if (!report.ok) throw new Error(JSON.stringify(report.problems));
 *
 * The target schema (created by the service's migrations) decides everything:
 *   - which tables: every base table in `public` except ov_migrations that SQLite also has (or `tables`), copied
 *     parents first (foreign-key order);
 *   - which columns: those both sides have. A source column the target lacks is a problem unless the table lists
 *     it in `dropColumns`; a target column the source lacks must have a default or be nullable;
 *   - each value's conversion, by the target column's type: 0/1 → boolean, text or epoch → timestamptz (SQLite's
 *     CURRENT_TIMESTAMP text is UTC), JSON text → jsonb (validated), JSON array text → PostgreSQL arrays,
 *     Buffer → bytea, anything → text for text columns.
 * Rows go in batched multi-row INSERTs in one transaction (identity columns keep their values, then their
 * sequences move past the maximum). Verification compares each table's row count and a checksum of every row,
 * canonicalised the same way on both sides and walked in primary-key order (byte order for text keys).
 */
const crypto = require('crypto');
const { sql } = require('./sql');

function toIso(v, col) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,}(\.\d+)?$/.test(v))) {
        const n = Number(v);
        return new Date(n > 1e11 ? n : n * 1000).toISOString();
    }
    const s = String(v).trim();
    let d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(`${s}T00:00:00Z`);
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) d = new Date(`${s.replace(' ', 'T')}Z`);   // SQLite CURRENT_TIMESTAMP: UTC
    else d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`${col}: "${s.slice(0, 40)}" is not a date/time`);
    return d.toISOString();
}

/** Convert one SQLite value for a PostgreSQL column type (information_schema udt_name). */
function convert(v, udt, col) {
    if (v === undefined || v === null) return null;
    if (udt.startsWith('_')) {   // array
        if (Array.isArray(v)) return v;
        if (typeof v === 'string' && v.trim().startsWith('[')) { const a = JSON.parse(v); if (!Array.isArray(a)) throw new Error(`${col}: not a JSON array`); return a; }
        if (v === '') return [];
        throw new Error(`${col}: cannot read "${String(v).slice(0, 40)}" as an array (store it as JSON text)`);
    }
    switch (udt) {
        case 'bool':
            if (typeof v === 'boolean') return v;
            if (v === 1 || v === '1' || v === 'true' || v === 't') return true;
            if (v === 0 || v === '0' || v === 'false' || v === 'f') return false;
            throw new Error(`${col}: "${v}" is not a boolean`);
        case 'int2': case 'int4': case 'int8': {
            const n = typeof v === 'bigint' ? Number(v) : Number(v);
            if (!Number.isSafeInteger(n)) throw new Error(`${col}: "${v}" is not an integer`);
            return n;
        }
        case 'float4': case 'float8': { const n = Number(v); if (Number.isNaN(n)) throw new Error(`${col}: "${v}" is not a number`); return n; }
        case 'numeric': return String(v);
        case 'timestamptz': case 'timestamp': return toIso(v, col);
        case 'date': return String(v).slice(0, 10);
        case 'json': case 'jsonb':
            if (typeof v === 'string') { if (v === '') return null; JSON.parse(v); return v; }
            if (Buffer.isBuffer(v)) { const s = v.toString('utf8'); JSON.parse(s); return s; }
            return JSON.stringify(v);
        case 'bytea': return Buffer.isBuffer(v) ? v : Buffer.from(String(v));
        default: return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    }
}

// The canonical text of a value for checksums (same rules on both sides).
function sortKeys(x) {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') return Object.keys(x).sort().reduce((o, k) => { o[k] = sortKeys(x[k]); return o; }, {});
    return x;
}
function canonical(v, udt) {
    if (v === null || v === undefined) return '\\N';
    if (udt === 'json' || udt === 'jsonb') {
        // JSON null and SQL NULL compare equal: a jsonb 'null' reads back as JS null, like a missing value.
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        return parsed === null ? '\\N' : JSON.stringify(sortKeys(parsed));
    }
    if (udt === 'bytea') return Buffer.isBuffer(v) ? v.toString('hex') : Buffer.from(String(v)).toString('hex');
    if (udt === 'timestamptz' || udt === 'timestamp') return new Date(v).toISOString();
    if (udt.startsWith('_')) return JSON.stringify(v);
    if (udt === 'numeric') return String(Number(v));
    return String(v);
}

async function schemaOf(db) {
    const cols = await db.many(sql`
        SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable = 'YES' AS nullable,
               c.column_default IS NOT NULL OR c.is_identity = 'YES' OR c.is_generated = 'ALWAYS' AS has_default,
               c.is_identity = 'YES' AS identity, c.is_generated = 'ALWAYS' AS generated
          FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'ov_migrations'
         ORDER BY c.table_name, c.ordinal_position`);
    const pks = await db.many(sql`
        SELECT tc.relname AS table_name, a.attname AS column_name, array_position(i.indkey::int2[], a.attnum) AS pos
          FROM pg_index i JOIN pg_class tc ON tc.oid = i.indrelid JOIN pg_namespace n ON n.oid = tc.relnamespace
          JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ANY(i.indkey)
         WHERE i.indisprimary AND n.nspname = 'public' ORDER BY 1, 3`);
    const fks = await db.many(sql`
        SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
          FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE c.contype = 'f' AND n.nspname = 'public'`);
    const tables = new Map();
    for (const c of cols) {
        if (!tables.has(c.table_name)) tables.set(c.table_name, { name: c.table_name, columns: [], pk: [] });
        tables.get(c.table_name).columns.push(c);
    }
    for (const p of pks) if (tables.has(p.table_name)) tables.get(p.table_name).pk.push(p.column_name);
    // Parents first.
    const deps = new Map([...tables.keys()].map((t) => [t, new Set()]));
    for (const f of fks) { const ch = f.child.replace(/"/g, ''); const pa = f.parent.replace(/"/g, ''); if (deps.has(ch) && ch !== pa) deps.get(ch).add(pa); }
    const order = []; const state = new Map();
    const visit = (t) => { if (state.get(t) === 2) return; if (state.get(t) === 1) return; state.set(t, 1); for (const p of deps.get(t) || []) visit(p); state.set(t, 2); order.push(t); };
    for (const t of [...tables.keys()].sort()) visit(t);
    return order.map((t) => tables.get(t));
}

/**
 * @param {object} o
 * @param {string|object} o.sqlite   a path, or an open better-sqlite3 Database
 * @param {object} o.db              createDb() handle with write rights on the tables (the owner role)
 * @param {object} [o.tables]        { [target]: { from?, dropColumns?: [], where?: 'SQL filter on the source', map?: (row) => row } }
 * @param {string[]} [o.only]        import only these target tables
 * @param {boolean} [o.truncate]     empty the target tables first (rehearsals)
 * @param {boolean} [o.verify]       compare counts and checksums (default true)
 * → { ok, tables: [{ table, source, rows, ms, checksum }], problems: [] }
 */
async function importSqlite({ sqlite, db, tables: opts = {}, only = null, truncate = false, verify = true, log = console } = {}) {
    let Database;
    const src = typeof sqlite === 'string' ? (() => { try { Database = require('better-sqlite3'); } catch { throw new Error('importSqlite: install better-sqlite3 to read the SQLite file'); } return new Database(sqlite, { readonly: true, fileMustExist: true }); })() : sqlite;
    const report = { ok: true, tables: [], problems: [] };
    const problem = (p) => { report.ok = false; report.problems.push(p); };
    try {
        const schema = (await schemaOf(db)).filter((t) => !only || only.includes(t.name));
        const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        const plan = [];
        for (const t of schema) {
            const o = opts[t.name] || {};
            const from = o.from || t.name;
            if (!srcTables.has(from)) { log.log && log.log(`[import] ${t.name}: no source table ${from} (left empty)`); continue; }
            const srcCols = src.prepare(`PRAGMA table_info("${from.replace(/"/g, '""')}")`).all().map((c) => c.name);
            const drop = new Set(o.dropColumns || []);
            const insertable = t.columns.filter((c) => !c.generated);
            const cols = insertable.filter((c) => srcCols.includes(c.column_name));
            const lost = srcCols.filter((c) => !t.columns.some((x) => x.column_name === c) && !drop.has(c));
            if (lost.length) problem({ table: t.name, problem: `source columns with no target column (list them in dropColumns to drop them): ${lost.join(', ')}` });
            const unfillable = insertable.filter((c) => !srcCols.includes(c.column_name) && !c.nullable && !c.has_default);
            if (unfillable.length) problem({ table: t.name, problem: `target columns the source cannot fill: ${unfillable.map((c) => c.column_name).join(', ')}` });
            plan.push({ t, from, cols, o });
        }
        if (!report.ok) return report;

        await db.tx(async (tx) => {
            if (truncate && plan.length) await tx.exec(sql`TRUNCATE ${sql.join(plan.map((p) => sql.ident(p.t.name)))} RESTART IDENTITY CASCADE`);
            for (const { t, from, cols, o } of plan) {
                const t0 = Date.now();
                const names = cols.map((c) => c.column_name);
                const hasIdentity = cols.some((c) => c.identity);
                const batch = Math.max(1, Math.min(1000, Math.floor(60000 / Math.max(1, names.length))));
                const stmt = src.prepare(`SELECT * FROM "${from.replace(/"/g, '""')}"${o.where ? ` WHERE ${o.where}` : ''}`);
                let rows = []; let n = 0;
                const flush = async () => {
                    if (!rows.length) return;
                    await tx.exec(sql`INSERT INTO ${sql.ident(t.name)} (${sql.join(names.map(sql.ident))}) ${hasIdentity ? sql`OVERRIDING SYSTEM VALUE ` : sql``}VALUES ${sql.join(rows.map((r) => sql`(${sql.join(r)})`))}`);
                    n += rows.length; rows = [];
                };
                for (const raw of stmt.iterate()) {
                    const row = o.map ? o.map({ ...raw }) : raw;
                    if (!row) continue;
                    rows.push(cols.map((c) => convert(row[c.column_name], c.udt_name, `${t.name}.${c.column_name}`)));
                    if (rows.length >= batch) await flush();
                }
                await flush();
                for (const c of cols.filter((x) => x.identity || /nextval\(/.test(String(x.column_default || '')))) {
                    await tx.query(sql`SELECT setval(pg_get_serial_sequence(${t.name}, ${c.column_name}), GREATEST((SELECT max(${sql.ident(c.column_name)}) FROM ${sql.ident(t.name)}), 1))`);
                }
                report.tables.push({ table: t.name, source: from, rows: n, ms: Date.now() - t0 });
                log.log && log.log(`[import] ${t.name}: ${n} rows in ${Date.now() - t0} ms`);
            }
        });

        if (verify) {
            for (const entry of report.tables) {
                const { t, from, cols, o } = plan.find((p) => p.t.name === entry.table);
                const result = await verifyTable({ src, db, t, from, cols, o });
                entry.checksum = result.pg.sum;
                if (result.sqlite.rows !== result.pg.rows || result.sqlite.sum !== result.pg.sum) {
                    problem({ table: t.name, problem: `verification failed: SQLite ${result.sqlite.rows} rows (${result.sqlite.sum}), PostgreSQL ${result.pg.rows} rows (${result.pg.sum})` });
                }
            }
        }
        return report;
    } finally {
        if (typeof sqlite === 'string') src.close();
    }
}

/**
 * Stream both sides in primary-key order and hash each canonical row: SQLite iterates ORDER BY the key (its
 * BINARY collation is byte order, as COLLATE "C"), PostgreSQL reads keyset pages of 5000 (OFFSET pages for a
 * composite key). A table without a primary key is sorted in memory by every column.
 */
async function verifyTable({ src, db, t, from, cols, o }) {
    const names = cols.map((c) => c.column_name);
    const keys = t.pk.filter((k) => names.includes(k));
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const text = new Set(cols.filter((c) => ['text', 'varchar', 'bpchar', 'citext', 'uuid'].includes(c.udt_name)).map((c) => c.column_name));
    const line = (vals) => vals.map((v, i) => canonical(v, cols[i].udt_name)).join('\t') + '\n';
    const convertRow = (row) => cols.map((c) => convert(row[c.column_name], c.udt_name, c.column_name));

    const h1 = crypto.createHash('sha256'); let c1 = 0;
    const where = o.where ? ` WHERE ${o.where}` : '';
    if (keys.length) {
        for (const raw of src.prepare(`SELECT * FROM ${q(from)}${where} ORDER BY ${keys.map(q).join(', ')}`).iterate()) {
            const row = o.map ? o.map({ ...raw }) : raw;
            if (!row) continue;
            h1.update(line(convertRow(row))); c1++;
        }
    } else {
        const all = src.prepare(`SELECT * FROM ${q(from)}${where}`).all().map((raw) => (o.map ? o.map({ ...raw }) : raw)).filter(Boolean).map(convertRow);
        all.sort((a, b) => cmpRows(a, b, names.map((_, i) => i)));
        for (const r of all) { h1.update(line(r)); c1++; }
    }

    const h2 = crypto.createHash('sha256'); let c2 = 0;
    const colList = sql.join(names.map(sql.ident));
    const orderBy = (ks) => sql.join(ks.map((k) => (text.has(k) ? sql`${sql.ident(k)} COLLATE "C"` : sql.ident(k))));
    const PAGE = 5000;
    if (keys.length === 1) {
        const k = keys[0]; let last = null;
        for (;;) {
            const cond = last === null ? sql`` : (text.has(k) ? sql`WHERE ${sql.ident(k)} COLLATE "C" > ${last}` : sql`WHERE ${sql.ident(k)} > ${last}`);
            const rows = await db.many(sql`SELECT ${colList} FROM ${sql.ident(t.name)} ${cond} ORDER BY ${orderBy([k])} LIMIT ${PAGE}`);
            for (const r of rows) { h2.update(line(names.map((n) => r[n]))); c2++; }
            if (rows.length < PAGE) break;
            last = rows[rows.length - 1][k];
        }
    } else {
        const ks = keys.length ? keys : names;
        for (let off = 0; ; off += PAGE) {
            const rows = await db.many(sql`SELECT ${colList} FROM ${sql.ident(t.name)} ORDER BY ${orderBy(ks)} LIMIT ${PAGE} OFFSET ${off}`);
            for (const r of rows) { h2.update(line(names.map((n) => r[n]))); c2++; }
            if (rows.length < PAGE) break;
        }
    }
    return { sqlite: { rows: c1, sum: h1.digest('hex').slice(0, 16) }, pg: { rows: c2, sum: h2.digest('hex').slice(0, 16) } };
}

/** Order rows the way PostgreSQL does with COLLATE "C" (byte order for text, numeric for numbers). */
function cmpRows(a, b, idx) {
    for (const i of idx) {
        const x = a[i]; const y = b[i];
        if (x === y) continue;
        if (x === null) return 1; if (y === null) return -1;   // NULLS LAST, PostgreSQL's default for ASC
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        const bx = Buffer.from(String(x)); const by = Buffer.from(String(y));
        const c = Buffer.compare(bx, by);
        if (c) return c;
    }
    return 0;
}

module.exports = { importSqlite, convert, canonical };
