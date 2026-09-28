# asyncify: converting a service from better-sqlite3 to openvibe-sdk/db

This directory holds the tools used to convert Wiki and Blog (2026-09-28). They are not part of the published package.

```
cd tools/asyncify && npm install
node asyncify.js --config my-service.json $(git -C <service> ls-files 'server/*.js' 'server/**/*.js') <service>/test/*.test.js
```

## asyncify.js

It parses every file with acorn and does the following:

1. It adds `await` to calls that now return a promise:
   - prepared statements (`db.prepare(…).get/all/run`, `q.<name>.…`, and any name assigned from `.prepare(…)`);
   - Publishing store methods reached as `<x>.<store>.<method>(`;
   - `store.tx(`;
   - `asyncMethods` and `asyncGlobals` from the config;
   - methods of module APIs (`apis`: a variable name → the file whose functions became async).
2. It makes the enclosing functions `async`.
3. It repeats across all the files until nothing changes.

It leaves some calls unawaited:
- A promise used as a value (`.then`, `.catch`, `.finally`, `Promise.all/race([...])`, `assert.rejects(p)`) stays a promise.
- A call inside an array callback (`map`, `filter`, `forEach`, …) is **reported** (`MANUAL …`), never changed, because an async callback there silently breaks the result. The same goes for an async function passed by name to an array method.

Fix those by hand, with a `for … of` loop, `await Promise.all(xs.map(async …))`, or better a batch read (`revisions.getMany`, `citations.forRevisions`, `reviews.latestMany`, or `= ANY(?)`).

It also rewrites `assert.throws(async …)` as `await assert.rejects(async …)`. An edit that would break the syntax is refused and reported.

The config has these keys: `stores`, `bareStores`, `syncStoreMethods`, `apis`, `syncNames`, `asyncGlobals` and `asyncMethods`. See `example-blog.json`.

What stays for a person:
- the SQL dialect: `INSERT OR IGNORE/REPLACE` → `ON CONFLICT`, `COLLATE NOCASE` → `lower()`, `LIKE` → `ILIKE`, `IS ?` → `IS NOT DISTINCT FROM`, `DISTINCT` + `ORDER BY`, `PRAGMA` and `sqlite_master` → `information_schema`;
- `RETURNING` in place of `lastInsertRowid`;
- the boot (open, migrate, `createApp` async) and the test helpers (`openvibe-sdk/testing` `createTestDb`).

Also by hand: `db.transaction(fn)()` → `db.tx(fn)` (the codemod leaves it), scalar `MAX(a, b)` → `GREATEST`, `rowid` tiebreaks → an identity `seq` column, and a `setImmediate` meant to run after a commit → `db.afterCommit`. The lessons list in `docs/migrating-to-postgresql.md` §7 has the rest.

## sqlite-schema-to-pg.js

`toPg(sqliteDdl)` turns the SCHEMA string a service's `db.js` ran into the first migration: `INTEGER PRIMARY KEY AUTOINCREMENT` → identity, `TEXT` → `text COLLATE "C"`, `INTEGER` → `bigint`, `REAL` → `double precision`, `BLOB` → `bytea`, and no `IF NOT EXISTS`. It refuses triggers.

## g1pass.py

`g1pass.py <svc> <Name> <ENVPREFIX>`, run in a Blog-shaped service's checkout, makes the edits that are the same in every such service: config (`DATABASE_URL`, `DATABASE_DIRECT_URL`, `VALKEY_URL`), the PostgreSQL outbox, Valkey actor limits, readiness, and the test boot on `createTestDb`. Each edit checks its anchor and is skipped when already applied.

## awaitify-tests.py

This is the earlier regex pass for test files (Wiki). `asyncify.js` over the server and the tests together supersedes it.
