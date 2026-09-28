'use strict';
/**
 * Ambient transactions and db.prepare: inside db.tx, plain db calls join the transaction (they see its writes,
 * roll back with it, and never wait on it); a db.tx inside it is a savepoint; a promise the transaction did not
 * await runs on the pool after it ends; db.detached leaves it on purpose. db.prepare compiles ? and @name/:name
 * to $n, leaves strings, identifiers, comments and :: casts alone, and gives get/all/run/pluck. PGlite always;
 * PostgreSQL through PgBouncer when OV_TEST_PG_URL is set.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createDb, sql } = require('../src/db');
const { compile } = require('../src/db/prepare');

function cases(label, open) {
    return [
        [`${label}: plain db calls inside db.tx join it; a rollback takes them back`, async () => {
            const { db, done } = await open();
            try {
                const ins = db.prepare('INSERT INTO items (name, qty) VALUES (?, ?) RETURNING id');
                const count = db.prepare('SELECT count(*)::int AS n FROM items').pluck();
                await assert.rejects(db.tx(async () => {
                    await ins.run('a', 1);
                    assert.equal(await count.get(), 1, 'the transaction sees its own write through db');
                    assert.equal(db.inTransaction(), true);
                    throw new Error('boom');
                }), /boom/);
                assert.equal(await count.get(), 0, 'rolled back');
                const id = await db.tx(async () => (await ins.run('b', 2)).lastInsertRowid);
                assert.equal(typeof id, 'number');
                assert.equal(db.inTransaction(), false);
                assert.equal(await count.get(), 1);
            } finally { await done(); }
        }],
        [`${label}: afterCommit runs after the commit, in order, never after a rollback; a failed savepoint drops its hooks`, async () => {
            const { db, done } = await open();
            try {
                const ins = db.prepare('INSERT INTO items (name, qty) VALUES (?, ?)');
                const seen = [];
                const committed = async (tag) => { seen.push([tag, db.inTransaction(), db.stats().open, await db.prepare('SELECT count(*)::int AS n FROM items').pluck().get()]); };
                await db.tx(async (t) => {
                    await ins.run('a', 1);
                    db.afterCommit(() => committed('ambient'));
                    t.afterCommit(() => committed('handle'));
                    await assert.rejects(db.tx(async () => { db.afterCommit(() => committed('dropped')); throw new Error('inner'); }), /inner/);
                    await db.tx(async () => { db.afterCommit(() => committed('kept')); });
                    db.afterCommit(() => { throw new Error('a failing hook is logged'); });
                    assert.deepEqual(seen, [], 'nothing runs inside the transaction');
                    assert.equal(db.stats().open, 1);
                });
                assert.deepEqual(seen, [['ambient', false, 0, 1], ['handle', false, 0, 1], ['kept', false, 0, 1]]);
                seen.length = 0;
                await assert.rejects(db.tx(async () => { await ins.run('b', 2); db.afterCommit(() => committed('rolled back')); throw new Error('boom'); }), /boom/);
                db.afterCommit(() => committed('outside'));
                assert.deepEqual(seen, [], 'outside a transaction: the next turn');
                await new Promise((r) => setImmediate(r));
                await new Promise((r) => setTimeout(r, 20));
                assert.deepEqual(seen, [['outside', false, 0, 1]]);
            } finally { await done(); }
        }],
        [`${label}: a db.tx inside is a savepoint; its failure undoes only itself`, async () => {
            const { db, done } = await open();
            try {
                const ins = db.prepare('INSERT INTO items (name, qty) VALUES (@name, @qty)');
                await db.tx(async () => {
                    await ins.run({ name: 'outer', qty: 1 });
                    await assert.rejects(db.tx(async () => { await ins.run({ name: 'inner', qty: 2 }); throw new Error('inner'); }), /inner/);
                    await db.tx(async () => ins.run({ name: 'kept', qty: 3 }));
                });
                assert.deepEqual(await db.prepare('SELECT name FROM items ORDER BY id').pluck().all(), ['outer', 'kept']);
            } finally { await done(); }
        }],
        [`${label}: work the transaction did not await runs on the pool afterwards; detached leaves on purpose`, async () => {
            const { db, done } = await open();
            try {
                let late;
                await db.tx(async () => {
                    await db.exec(sql`INSERT INTO items (name, qty) VALUES ('t', 1)`);
                    late = new Promise((r) => setTimeout(r, 20)).then(() => db.value(sql`SELECT count(*)::int FROM items`));
                });
                assert.equal(await late, 1, 'ran after the commit, on the pool');
                if (label !== 'pglite') {
                    await db.tx(async () => {
                        await db.exec(sql`INSERT INTO items (name, qty) VALUES ('u', 1)`);
                        assert.equal(await db.detached(() => db.value(sql`SELECT count(*)::int FROM items`)), 1, 'detached does not see the uncommitted row');
                    });
                }
            } finally { await done(); }
        }],
        [`${label}: prepare binds positional, named (reused) and arrays; missing parameters are refused`, async () => {
            const { db, done } = await open();
            try {
                await db.prepare('INSERT INTO items (name, qty) VALUES (?, ?), (?, ?)').run(['x', 5, 'y', 7]);
                const q = db.prepare("SELECT name FROM items WHERE (@name::text IS NULL OR name = @name) AND qty >= :min AND name <> 'a?b' ORDER BY name");
                assert.deepEqual((await q.all({ name: null, min: 6 })).map((r) => r.name), ['y']);
                assert.deepEqual((await q.all({ name: 'x', min: 0 })).map((r) => r.name), ['x']);
                assert.equal(await db.prepare('SELECT name FROM items WHERE qty = ?').get(99), undefined, 'no row is undefined, as in better-sqlite3');
                assert.equal((await db.prepare('UPDATE items SET qty = qty + 1 WHERE qty > ?').run(0)).changes, 2);
                assert.deepEqual(await db.prepare('SELECT name FROM items WHERE name = ANY(?) ORDER BY name').pluck().all(['x', 'y', 'zz']), ['x', 'y'], 'one parameter: an array is its value');
                await assert.rejects(q.all({ name: 'x' }), /missing parameter @min/);
                await assert.rejects(db.prepare('SELECT ? AS a').get(), /expected 1 parameter/);
            } finally { await done(); }
        }],
    ];
}

const tests = [['compile: strings, identifiers, comments, dollar quotes and casts are left alone', () => {
    assert.throws(() => compile('SELECT ?, @a'), /either \? or named/);
    const c = compile(`SELECT 'it''s ?', "@x", $$ :y ? $$, @a::int, :b, @a -- ?\n/* @c */`);
    assert.equal(c.text, `SELECT 'it''s ?', "@x", $$ :y ? $$, $1::int, $2, $1 -- ?\n/* @c */`);
    assert.deepEqual(c.names, ['a', 'b']);
    assert.equal(compile('SELECT ?, ?').text, 'SELECT $1, $2');
}]];

const schema = 'CREATE TABLE items (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, qty integer NOT NULL)';
tests.push(...cases('pglite', async () => {
    const db = createDb({ pglite: true });
    await db.query(schema);
    return { db, done: () => db.close() };
}));
if (process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL) {
    tests.push(...cases('postgresql+pgbouncer', async () => {
        const owner = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL });
        await owner.query('DROP TABLE IF EXISTS items');
        await owner.query(schema);
        await owner.query('GRANT ALL ON items TO PUBLIC').catch(() => {});
        await owner.close();
        const db = createDb({ url: process.env.OV_TEST_PG_URL, max: 4 });
        return { db, done: () => db.close() };
    }));
} else console.log('db ambient through PgBouncer: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');

run(tests);
