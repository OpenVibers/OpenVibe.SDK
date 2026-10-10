'use strict';
/**
 * db (ADR-035): the sql builder binds every value; both adapters return the same row shapes (int8 → Number,
 * timestamps → ISO, dates → 'YYYY-MM-DD', numeric → exact text, json parsed); transactions commit, roll back
 * and nest as savepoints; serializable conflicts retry; migrations run once, in order, refuse edits, and hold a
 * contract migration inside the N-1 window;
 * converts by target type, keeps identity values, and verifies counts and checksums. The suite runs on PGlite
 * always, and again through PgBouncer against PostgreSQL 18 when OV_TEST_PG_URL is set
 * (scripts/test-services.sh up).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./helpers');
const { createDb, sql } = require('../src/db');
const { parse } = require('../src/db/migrate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovsdk-db-'));
const mdir = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text); return d; };
const PAGES = mdir('pages', {
    '0001_pages.sql': `-- phase: expand
CREATE TABLE spaces (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
CREATE TABLE pages (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, space_id bigint REFERENCES spaces(id), slug text NOT NULL UNIQUE,
  title text NOT NULL, meta jsonb NOT NULL DEFAULT '{}', public boolean NOT NULL DEFAULT true, views bigint NOT NULL DEFAULT 0,
  price numeric(10,2), tags text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), day date);
`,
});

function suite(label, open) {
    return [
        [`${label}: sql binds values, fragments nest, identifiers are checked`, async () => {
            const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ANY(${[2, 3]}) AND ${sql`c = ${'x'}`}`.compile();
            assert.equal(q.text, 'SELECT * FROM t WHERE a = $1 AND b = ANY($2) AND c = $3');
            assert.deepEqual(q.values, [1, [2, 3], 'x']);
            assert.equal(sql`${sql.ident('public.pages')}`.compile().text, '"public"."pages"');
            assert.throws(() => sql.ident('pages; DROP TABLE x'), /not an identifier/);
            const ins = sql`INSERT INTO t ${sql.insert([{ a: 1, b: null }, { a: 2, b: 'y' }])}`.compile();
            assert.equal(ins.text, 'INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4)');
            assert.equal(sql`UPDATE t SET ${sql.set({ a: 1, skip: undefined, b: 2 })}`.compile().text, 'UPDATE t SET "a" = $1, "b" = $2');
        }],
        [`${label}: migrations, types, queries, transactions`, async () => {
            const { db, migrate } = await open();
            try {
                const m = await migrate(PAGES);
                assert.deepEqual(m.applied.map((a) => a.id), ['0001']);
                assert.equal((await migrate(PAGES)).applied.length, 0, 'applied once');
                const sp = await db.one(sql`INSERT INTO spaces (name) VALUES (${'main'}) RETURNING id`);
                await db.exec(sql`INSERT INTO pages ${sql.insert([
                    { space_id: sp.id, slug: 'a', title: 'A', meta: JSON.stringify({ x: 1, list: [] }), price: '12.50', tags: ['x', 'y'], day: '2026-09-28' },
                    { space_id: sp.id, slug: 'b', title: 'B', meta: '{}', public: false, price: null, tags: [], day: null },
                ])}`);
                const a = await db.one(sql`SELECT * FROM pages WHERE slug = ${'a'}`);
                assert.equal(typeof a.id, 'number');
                assert.deepEqual(a.meta, { x: 1, list: [] });
                assert.equal(a.price, '12.50', 'numeric stays exact text');
                assert.deepEqual(a.tags, ['x', 'y']);
                assert.match(a.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                assert.equal(a.day, '2026-09-28');
                assert.equal(a.public, true);
                assert.equal(await db.maybe(sql`SELECT 1 FROM pages WHERE slug = ${'zzz'}`), null);
                await assert.rejects(db.one(sql`SELECT 1 FROM pages WHERE slug = ${'zzz'}`), /expected one row/);
                assert.equal(await db.value(sql`SELECT count(*) FROM pages`), 2);
                assert.deepEqual((await db.many(sql`SELECT slug FROM pages WHERE slug = ANY(${['a', 'b']}) ORDER BY slug`)).map((r) => r.slug), ['a', 'b']);
                // A transaction commits; an inner savepoint rolls back alone; a thrown error rolls everything back.
                const title = await db.tx(async (t) => {
                    await t.exec(sql`UPDATE pages SET views = views + 1 WHERE slug = 'a'`);
                    await t.tx(async (s) => { await s.exec(sql`UPDATE pages SET title = 'X'`); throw new Error('inner'); }).catch(() => {});
                    return t.value(sql`SELECT title FROM pages WHERE slug = 'a'`);
                });
                assert.equal(title, 'A');
                assert.equal(await db.value(sql`SELECT views FROM pages WHERE slug = 'a'`), 1);
                await assert.rejects(db.tx(async (t) => { await t.exec(sql`UPDATE pages SET views = 99`); throw new Error('boom'); }), /boom/);
                assert.equal(await db.value(sql`SELECT views FROM pages WHERE slug = 'a'`), 1, 'rolled back');
                await assert.rejects(db.tx(async () => {}, { isolation: 'nonsense' }), /isolation/);
                // Errors carry the PostgreSQL code and the statement, not the values.
                const err = await db.exec(sql`INSERT INTO pages (slug, title) VALUES (${'a'}, ${'dup'})`).catch((e) => e);
                assert.equal(err.code, '23505');
                assert.match(err.statement, /INSERT INTO pages/);
                // Serializable increments from 8 concurrent transactions all land (retries on 40001).
                await Promise.all(Array.from({ length: 8 }, () => db.tx(async (t) => {
                    const v = await t.value(sql`SELECT views FROM pages WHERE slug = 'b'`);
                    await t.exec(sql`UPDATE pages SET views = ${v + 1} WHERE slug = 'b'`);
                }, { isolation: 'serializable', retries: 30 })));
                assert.equal(await db.value(sql`SELECT views FROM pages WHERE slug = 'b'`), 8);
                const r = await db.ready();
                assert.equal(r.ok, true);
                assert.equal(r.detail.store, label === 'pglite' ? 'pglite' : 'postgresql');
            } finally { await db.close(); }
        }],
    ];
}

async function pgOpen() {
    // Migrations run as the owner on the direct connection; everything else through PgBouncer, as in production.
    const owner = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'sdk-test' });
    await owner.query('DROP TABLE IF EXISTS pages, spaces, ov_migrations CASCADE');
    const db = createDb({ url: process.env.OV_TEST_PG_URL, service: 'sdk-test', max: 4 });
    const close = db.close;
    db.close = async () => { await close(); await owner.close(); };
    return { db, migrate: (dir) => owner.migrate({ dir, log: { log() {} } }) };
}

const tests = [
    ...suite('pglite', async () => { const db = createDb({ pglite: true, service: 'sdk-test' }); return { db, migrate: (dir) => db.migrate({ dir, log: { log() {} } }) }; }),
    ['migration rules: phases, edits refused, order kept, contract held in the N-1 window, no-transaction', async () => {
        assert.throws(() => parse(mdir('bad1', { 'x.sql': '-- phase: expand\nSELECT 1;' })), /NNNN_description/);
        assert.throws(() => parse(mdir('bad2', { '0001_a.sql': 'SELECT 1;' })), /phase/);
        assert.throws(() => parse(mdir('bad3', { '0001_a.sql': '-- phase: contract\nSELECT 1;' })), /must name its expand/);
        const db = createDb({ pglite: true });
        const quiet = { log() {} };
        try {
            const d = mdir('rules', {
                '0001_add.sql': '-- phase: expand\nCREATE TABLE t (id int PRIMARY KEY, old text, new text);',
                '0002_fill.sql': '-- phase: migrate\nUPDATE t SET new = old;',
                '0003_drop.sql': '-- phase: contract\n-- after: 0001\nALTER TABLE t DROP COLUMN old;',
                '0004_idx.sql': '-- phase: expand\n-- no-transaction\nCREATE INDEX t_new ON t (new);',
            });
            let r = await db.migrate({ dir: d, log: quiet });
            assert.deepEqual(r.applied.map((a) => a.id), ['0001', '0002']);
            assert.match(r.held[0].reason, /N-1 window is 7/);
            r = await db.migrate({ dir: d, log: quiet, now: () => Date.now() + 8 * 86400000 });
            assert.deepEqual(r.applied.map((a) => a.id), ['0003', '0004'], 'after the window the contract runs, then the rest');
            fs.writeFileSync(path.join(d, '0002_fill.sql'), '-- phase: migrate\nUPDATE t SET new = upper(old);');
            await assert.rejects(db.migrate({ dir: d, log: quiet }), /changed after it was applied/);
        } finally { await db.close(); }
        const db2 = createDb({ pglite: true });
        try {
            const d2 = mdir('order', { '0001_add.sql': '-- phase: expand\nCREATE TABLE u (id int);', '0005_b.sql': '-- phase: expand\nSELECT 1;' });
            await db2.migrate({ dir: d2, log: quiet });
            fs.writeFileSync(path.join(d2, '0003_late.sql'), '-- phase: expand\nSELECT 1;');
            await assert.rejects(db2.migrate({ dir: d2, log: quiet }), /older than applied migration 0005/);
        } finally { await db2.close(); }
    }],
];

if (process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL) tests.push(...suite('postgresql+pgbouncer', pgOpen));
else console.log('db through PgBouncer: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');

run(tests).then(() => fs.rmSync(tmp, { recursive: true, force: true }));
