'use strict';
/**
 * openvibe-sdk/db — the async data layer every service uses (ADR-035, roadmap WS-X2).
 *
 * PostgreSQL is the only dialect. Production connects with node-postgres through PgBouncer in transaction mode
 * (DATABASE_URL); tests and embedded tools run real PostgreSQL in-process with PGlite, so what is tested is what
 * runs. Both adapters return identical rows: int8 as Number (refused beyond 2^53), timestamps as ISO-8601
 * strings, dates as 'YYYY-MM-DD', numeric as a string (exact), json/jsonb parsed.
 *
 *   const { createDb, sql } = require('openvibe-sdk/db');
 *   const db = createDb({ service: 'wiki' });                 // DATABASE_URL, or { url }, or { pglite: true }
 *   const page = await db.maybe(sql`SELECT id, title FROM pages WHERE slug = ${slug}`);
 *   await db.tx(async (t) => { … }, { isolation: 'serializable' });   // 40001/40P01 retried
 *   await db.migrate({ dir: path.join(__dirname, 'migrations') });    // with DATABASE_DIRECT_URL
 *
 * Ambient transactions (default on): inside db.tx(fn), plain db.* calls (and db.prepare statements, and library stores
 * handed `db`) join the running transaction through AsyncLocalStorage, so code converted from better-sqlite3 need not
 * thread the handle through every function. A db.tx inside it is a savepoint. Work that outlives the transaction (a
 * promise it did not await) runs on the pool once it has ended; db.detached(fn) runs fn outside it on purpose.
 * createDb({ ambient: false }) turns this off. The handle fn receives works either way.
 *
 *   const q = db.prepare('SELECT * FROM pages WHERE id = ?');   // better-sqlite3-shaped, async: get / all / run
 *   const page = await q.get(id);
 *
 * Rules the pooler imposes (ADR-007 2026-09-24 rule 1): no session state between transactions (no session SET,
 * no LISTEN, no advisory locks held across transactions) on DATABASE_URL. Migrations use DATABASE_DIRECT_URL.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { sql, isSql } = require('./sql');
const { prepare } = require('./prepare');

const ISOLATION = { 'read committed': 'READ COMMITTED', 'repeatable read': 'REPEATABLE READ', serializable: 'SERIALIZABLE' };
const RETRYABLE = new Set(['40001', '40P01']);   // serialization failure, deadlock

// One set of type parsers for both adapters (text-format values from the server).
function int8(v) {
    if (v === null || v === undefined) return v;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new RangeError(`openvibe-sdk/db: int8 value ${v} is beyond 2^53; select it as text`);
    return n;
}
const PARSERS = {
    20: int8,                                     // int8
    1700: (v) => v,                               // numeric: exact, as text
    1114: (v) => (v == null ? v : new Date(`${v.replace(' ', 'T')}Z`).toISOString()),   // timestamp (UTC by convention)
    1184: (v) => (v == null ? v : new Date(normaliseTz(v)).toISOString()),              // timestamptz
    1082: (v) => v,                               // date
    114: (v) => (v == null ? v : JSON.parse(v)),  // json
    3802: (v) => (v == null ? v : JSON.parse(v)), // jsonb
    17: (v) => (v == null ? v : Buffer.from(String(v).slice(2), 'hex')),   // bytea ('\\x…' hex): a Buffer from both adapters
};
function normaliseTz(v) {
    // '2026-09-28 10:47:22.411+00' → '2026-09-28T10:47:22.411+00:00'
    let s = v.replace(' ', 'T');
    if (/[+-]\d\d$/.test(s)) s += ':00';
    return s;
}

function compileArgs(q, values) {
    if (isSql(q)) return q.compile();
    if (typeof q === 'string') return { text: q, values: values || [] };
    throw new TypeError('openvibe-sdk/db: pass sql`…` or (text, values)');
}

class DbError extends Error {
    constructor(message, cause, extra = {}) { super(message); this.name = 'DbError'; this.cause = cause; Object.assign(this, extra); }
}

/** The query methods, shared by the pool, a transaction and a savepoint. `run(text, values)` → { rows, rowCount }. */
function queryApi(run, self) {
    const api = {
        async query(q, values) { const c = compileArgs(q, values); return run(c.text, c.values); },
        async many(q, values) { return (await api.query(q, values)).rows; },
        async maybe(q, values) { const r = await api.query(q, values); return r.rows[0] || null; },
        async one(q, values) {
            const r = await api.query(q, values);
            if (!r.rows.length) throw new DbError('openvibe-sdk/db: expected one row, got none', null, { code: 'no_rows' });
            return r.rows[0];
        },
        async value(q, values) { const r = await api.query(q, values); const row = r.rows[0]; return row ? row[Object.keys(row)[0]] : null; },
        async exec(q, values) { return (await api.query(q, values)).rowCount; },
    };
    return Object.assign(self, api);
}

/**
 * @param {object} [o]
 * @param {string} [o.url]            postgres URL (default DATABASE_URL)
 * @param {boolean|string|object} [o.pglite]  true: an in-memory PGlite; a directory: persisted PGlite; or a PGlite instance
 * @param {string} [o.service]        application_name and metric label
 * @param {number} [o.max]            pool size per process (default 10; PgBouncer multiplexes)
 * @param {number} [o.queryTimeoutMs] client-side cap per query (default 15000; the runtime role also has a server-side one)
 * @param {number} [o.slowMs]         log statements slower than this (default 500), text only, never values
 * @param {object} [o.log]            { warn, error } (default console)
 * @param {object} [o.registry]       openvibe-shared/metrics registry: db_query_seconds histogram, pool gauges
 */
function createDb(o = {}) {
    const log = o.log || console;
    const service = o.service || process.env.OV_SERVICE || 'service';
    const slowMs = o.slowMs == null ? (o.pglite ? Infinity : 500) : o.slowMs;   // PGlite's first query includes its WASM start
    const stats = { queries: 0, errors: 0, slow: 0, retries: 0, tx: 0, open: 0 };
    let hist = null;
    if (o.registry && typeof o.registry.histogram === 'function') {
        try { hist = o.registry.histogram({ name: 'db_query_seconds', help: 'Database query time by kind', labelNames: ['kind'], buckets: [0.001, 0.005, 0.02, 0.1, 0.5, 2, 10] }); } catch { hist = null; }
    }
    const kindOf = (text) => (text.trimStart().slice(0, 6).toUpperCase().match(/^(SELECT|INSERT|UPDATE|DELETE|WITH)/) || ['OTHER'])[0].toLowerCase();

    let adapter;
    if (o.pglite) adapter = pgliteAdapter(o.pglite);
    else adapter = pgAdapter({ url: o.url || process.env.DATABASE_URL, max: o.max || 10, service, queryTimeoutMs: o.queryTimeoutMs || 15000, log });

    // One query at a time per transaction connection: a transaction's statements are ordered anyway, and node-postgres
    // deprecates queuing a query on a busy client (pg@9 refuses it). Promise.all over db calls inside a transaction
    // (a list read concurrently) is therefore safe; outside one, each call takes its own pool connection.
    const lanes = new WeakMap();
    function timed(conn, text, values) {
        if (!conn || typeof conn !== 'object') return timedRun(conn, text, values);
        const prev = lanes.get(conn) || Promise.resolve();
        const next = prev.then(() => timedRun(conn, text, values));
        lanes.set(conn, next.then(() => {}, () => {}));
        return next;
    }

    async function timedRun(conn, text, values) {
        const t0 = process.hrtime.bigint();
        try {
            const r = await adapter.run(conn, text, values);
            stats.queries++;
            return r;
        } catch (err) {
            stats.errors++;
            throw wrap(err, text);
        } finally {
            const s = Number(process.hrtime.bigint() - t0) / 1e9;
            if (hist) { try { hist.observe({ kind: kindOf(text) }, s); } catch { /* metrics never break a query */ } }
            if (s * 1000 > slowMs) { stats.slow++; log.warn(`[db] slow (${Math.round(s * 1000)} ms): ${text.replace(/\s+/g, ' ').slice(0, 160)}`); }
        }
    }

    const als = o.ambient === false ? null : new AsyncLocalStorage();
    const current = () => {
        const cur = als && als.getStore();
        return cur && !cur.done ? cur : null;
    };
    const inScope = (scope, fn) => (als ? als.run(scope, fn) : fn());

    async function tx(fn, opts = {}, conn = null, depth = 0, hooks = null) {
        if (!conn) {
            const cur = current();
            if (cur) { conn = cur.conn; depth = cur.depth; hooks = cur.hooks; }   // ambient: a savepoint in the running transaction
        }
        if (conn) {
            // Nested: a savepoint inside the running transaction. Its after-commit hooks go with it if it rolls back.
            const name = `sp_${depth}`;
            const mark = hooks.length;
            await timed(conn, `SAVEPOINT ${name}`, []);
            try {
                const out = await inScope({ conn, depth: depth + 1, done: false, hooks }, () => fn(txApi(conn, depth + 1, hooks)));
                await timed(conn, `RELEASE SAVEPOINT ${name}`, []);
                return out;
            } catch (err) { hooks.length = mark; await timed(conn, `ROLLBACK TO SAVEPOINT ${name}`, []).catch(() => {}); throw err; }
        }
        const iso = ISOLATION[opts.isolation || 'read committed'];
        if (!iso) throw new TypeError(`openvibe-sdk/db: isolation must be one of ${Object.keys(ISOLATION).join(', ')}`);
        const retries = opts.retries == null ? (opts.isolation === 'serializable' ? 5 : 2) : opts.retries;
        for (let attempt = 0; ; attempt++) {
            const c = await adapter.acquire();
            stats.tx++;
            stats.open++;
            const scope = { conn: c, depth: 1, done: false, hooks: [] };
            let committed = false;
            try {
                await timed(c, `BEGIN ISOLATION LEVEL ${iso}${opts.readOnly ? ' READ ONLY' : ''}`, []);
                const out = await inScope(scope, () => fn(txApi(c, 1, scope.hooks)));
                scope.done = true;
                await timed(c, 'COMMIT', []);
                committed = true;
                stats.open--;
                adapter.release(c);
                await runHooks(scope.hooks);
                return out;
            } catch (err) {
                if (committed) throw err;
                scope.done = true;
                stats.open--;
                await timed(c, 'ROLLBACK', []).catch(() => {});
                const code = err && (err.code || (err.cause && err.cause.code));
                if (RETRYABLE.has(code) && attempt < retries) {
                    stats.retries++;
                    await new Promise((r) => setTimeout(r, Math.min(1000, 10 * 2 ** attempt) + Math.random() * 20));
                    continue;
                }
                throw err;
            } finally { if (!committed) adapter.release(c); }
        }
    }

    /** After-commit hooks run in order, outside the transaction; one that throws is logged and the rest still run. */
    async function runHooks(hooks) {
        for (const h of hooks) {
            try { await h(); } catch (err) { log.warn(`[db] after-commit hook failed: ${err && err.message ? err.message : err}`); }
        }
    }
    function afterCommit(hooks, fn) {
        if (typeof fn !== 'function') throw new TypeError('openvibe-sdk/db: afterCommit(fn) needs a function');
        if (hooks) { hooks.push(fn); return; }
        setImmediate(() => runHooks([fn]));   // no transaction: nothing to wait for but the caller's own turn
    }

    function txApi(conn, depth, hooks) {
        const t = queryApi((text, values) => timed(conn, text, values), {});
        t.tx = (fn) => tx(fn, {}, conn, depth, hooks);
        t.afterCommit = (fn) => afterCommit(hooks, fn);
        t.sql = sql;
        t.prepare = (text) => prepare(t, text);
        return t;
    }

    const db = queryApi((text, values) => { const cur = current(); return timed(cur ? cur.conn : null, text, values); }, {});
    db.sql = sql;
    db.tx = (fn, opts) => tx(fn, opts);
    /** Async statements shaped like better-sqlite3's (get / all / run / pluck), with ? and @name / :name parameters. */
    db.prepare = (text) => prepare(db, text);
    /** True while this code runs inside db.tx (ambient mode). */
    db.inTransaction = () => Boolean(current());
    /**
     * Run fn once the running transaction commits (never if it rolls back; a savepoint that rolls back drops the hooks
     * added inside it). Outside a transaction, fn runs on the next turn. Hooks are awaited in order before db.tx
     * resolves, with the connection already back in the pool: a hook that must not delay the caller starts its work
     * and returns. For calls to other services that must see committed state (the setImmediate-after-a-synchronous-
     * better-sqlite3-transaction pattern).
     */
    db.afterCommit = (fn) => { const cur = current(); afterCommit(cur ? cur.hooks : null, fn); };
    /** Run fn outside any ambient transaction (its queries take a pool connection). */
    db.detached = (fn) => (als ? als.exit(fn) : fn());
    db.store = adapter.store;
    db.stats = () => ({ ...stats, pool: adapter.pool() });
    /** Readiness: a real round trip, and which store answered (never claimed from configuration). */
    db.ready = async () => {
        try {
            const v = await db.value(sql`SELECT 1 AS ok`);
            return v === 1 ? { ok: true, detail: { store: adapter.store, pool: adapter.pool() } } : { ok: false, error: 'unexpected answer' };
        } catch (err) { return { ok: false, error: `${adapter.store}: ${err.message}` }; }
    };
    db.migrate = (m) => require('./migrate').migrate({ db, ...m, log: m && m.log ? m.log : log });
    db.close = () => adapter.close();
    db._adapter = adapter;
    if (hist === null && o.registry && typeof o.registry.gauge === 'function') { /* histogram unsupported: counts still in stats() */ }
    if (o.registry && typeof o.registry.gauge === 'function') {
        try {
            o.registry.gauge({ name: 'db_pool_connections', help: 'Database pool connections by state', labelNames: ['state'],
                collect: () => { const p = adapter.pool(); return [{ labels: { state: 'total' }, value: p.total }, { labels: { state: 'idle' }, value: p.idle }, { labels: { state: 'waiting' }, value: p.waiting }]; } });
        } catch { /* registered already */ }
    }
    return db;
}

function wrap(err, text) {
    if (err instanceof DbError) return err;
    const e = new DbError(err.message, err, { code: err.code, detail: err.detail, constraint: err.constraint, table: err.table, column: err.column });
    e.statement = text.replace(/\s+/g, ' ').slice(0, 200);
    return e;
}

// ── node-postgres ──────────────────────────────────────────────────────────────────────────
function pgAdapter({ url, max, service, queryTimeoutMs, log }) {
    if (!url) throw new Error('openvibe-sdk/db: DATABASE_URL is not set (or pass { url } or { pglite: true })');
    let pg;
    try { pg = require('pg'); } catch { throw new Error('openvibe-sdk/db: install `pg` in the service (npm i pg)'); }
    const types = {
        getTypeParser(oid, format) {
            if (format === 'text' && PARSERS[oid]) return PARSERS[oid];
            return pg.types.getTypeParser(oid, format);
        },
    };
    const pool = new pg.Pool({ connectionString: url, max, application_name: service, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, query_timeout: queryTimeoutMs, types, keepAlive: true });
    pool.on('error', (err) => log.error(`[db] idle client error: ${err.message}`));
    return {
        store: 'postgresql',
        run: (conn, text, values) => (conn || pool).query({ text, values }).then((r) => ({ rows: r.rows, rowCount: r.rowCount })),
        acquire: () => pool.connect(),
        release: (c) => c.release(),
        pool: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
        close: () => pool.end(),
    };
}

// ── PGlite (tests, embedded) ───────────────────────────────────────────────────────────────
function pgliteAdapter(opt) {
    let mod;
    try { mod = require('@electric-sql/pglite'); } catch { throw new Error('openvibe-sdk/db: install `@electric-sql/pglite` for { pglite } (tests)'); }
    const parsers = {};
    for (const [oid, fn] of Object.entries(PARSERS)) parsers[oid] = (v) => fn(v);
    const inst = typeof opt === 'object' && opt && typeof opt.query === 'function' ? opt
        : new mod.PGlite(typeof opt === 'string' ? opt : undefined, { parsers });
    // PGlite is one connection: transactions take turns through this queue so statements never interleave.
    let chain = Promise.resolve();
    let holder = null;
    const conn = { id: 'pglite' };
    return {
        store: 'pglite',
        async run(c, text, values) {
            if (c === null && holder) {
                // A statement outside a transaction waits for the running one to finish. Inside that transaction's
                // own code this would never finish (production would just take another pooled connection), so say so.
                let timer;
                const waited = await Promise.race([chain.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), 10000); })]);
                clearTimeout(timer);
                if (!waited) throw new Error('openvibe-sdk/db (PGlite): a query outside a transaction waited 10 s for it; inside db.tx(fn) use the handle fn receives');
            }
            // Several statements without parameters (a migration file) go through exec, as node-postgres's simple protocol does.
            if ((!values || !values.length) && text.replace(/;\s*$/, '').includes(';')) {
                const results = await inst.exec(text, { parsers });
                const last = results[results.length - 1] || { rows: [] };
                return { rows: last.rows || [], rowCount: last.affectedRows != null ? last.affectedRows : (last.rows || []).length };
            }
            const r = await inst.query(text, values, { parsers });
            return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
        },
        acquire() {
            let release;
            const turn = new Promise((r) => { release = r; });
            const prev = chain;
            chain = prev.then(() => turn);
            return prev.then(() => { holder = { release }; return conn; });
        },
        release() { const h = holder; holder = null; if (h) h.release(); },
        pool: () => ({ total: 1, idle: holder ? 0 : 1, waiting: 0 }),
        close: () => inst.close(),
        instance: inst,
    };
}

module.exports = { createDb, sql, DbError, PARSERS, ISOLATION };
