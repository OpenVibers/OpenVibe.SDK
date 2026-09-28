# Moving a service from SQLite to PostgreSQL and Valkey

ADR-035 (and its amendment) moves every OpenVibe service from its own synchronous SQLite database to:
- **PostgreSQL 18**, through PgBouncer in transaction mode;
- **Valkey 9**, for shared, non-authoritative state;

and makes each service async from end to end. This guide is how every migration is done, so the results look the same everywhere. Read it with the roadmap's engineering standards (section 4B.7): async request paths, bounded pools, Valkey for shared state, indexes for every query shape, keyset pagination, no N+1 queries, and measured budgets.

## 0. What you get from the platform

- **The data role on the host** (OpenVibe.Host `roles/data/`): PostgreSQL, PgBouncer, pgBackRest and Valkey on loopback.
  - `sudo /opt/openvibe.host/roles/data/add-service.sh <svc>` gives the service a database `ov_<svc>`, an owner role, a pooled runtime role (DML only, 15 s statement timeout) and a Valkey user confined to `ov:<svc>:*`.
  - It writes four settings into `/etc/openvibe/<svc>.env`: `DATABASE_URL` (runtime role, through PgBouncer), `DATABASE_DIRECT_URL` (owner role: migrations), `VALKEY_URL` and `VALKEY_PREFIX`.
- **openvibe-sdk ≥ 0.15.0:**
  - `openvibe-sdk/db`: `createDb`, the `sql` tag, `tx`, `migrate` and `importSqlite`;
  - `openvibe-sdk/valkey`, `cache`, `queue` and `pubsub`, and `limits` with `createValkeyLimitStore`;
  - `openvibe-sdk/events`: `createPgOutbox`, `createPgInbox`, `outboxSchema` and `inboxSchema`.
- **Tests:** `@electric-sql/pglite` runs real PostgreSQL in-process. `openvibe-sdk/scripts/test-services.sh up` starts the production-shaped container set (PostgreSQL 18, PgBouncer and Valkey) for integration runs.

## 1. Dependencies

```
npm i pg iovalkey
npm i -D @electric-sql/pglite
# keep better-sqlite3 until the production import is done (the importer reads the old file); drop it after
```

Pin `openvibe-sdk` to `v0.15.0` or later. If the service uses `openvibe-publishing` or `openvibe-shared/config` / `analytics`, pin their PostgreSQL majors (see their CHANGELOGs).

## 2. The schema, as migrations

Create `migrations/0001_initial.sql` (`-- phase: expand`). It reproduces today's schema in PostgreSQL types, so the data can be imported as it is:

| SQLite today | PostgreSQL |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (the importer keeps the values and moves the sequence) |
| `INTEGER` holding 0/1 | `boolean` (and change the code: `row.flag === 1` becomes `row.flag`) |
| `INTEGER` epoch milliseconds (`created_at INTEGER NOT NULL`) | **`bigint`**, kept in milliseconds, so the API still sends the same numbers |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` / ISO text | `timestamptz NOT NULL DEFAULT now()`; the layer returns ISO-8601 strings (check what the API sent before and keep the format where clients depend on it) |
| `TEXT` holding JSON | `jsonb` (and stop calling `JSON.parse` on it: rows come back parsed) |
| `TEXT` (UUID, ULID, slug) | `text` with the same `CHECK`s; `citext` or a `lower()` index where the code compared `COLLATE NOCASE` |
| `REAL` | `double precision`; money stays integer cents (`bigint`), never float |
| `SUM(int)`, `SUM(bigint)`, `AVG(…)` | PostgreSQL returns `numeric`, which the layer gives as a **string**. Cast sums that must stay numbers: `SUM(amount)::bigint` (found in the Tips migration) |
| `BLOB` | `bytea` |
| `CHECK (x IN (…))` | the same `CHECK` (or an enum type only if it never changes) |

Then:
- **Indexes.** Add one for every query shape the routes run. That means every `WHERE` + `ORDER BY` pair on a list route, and a partial index for "due" or "unsent" queries (for example `WHERE sent_at IS NULL`).
- **Tables.** Put the outbox and inbox DDL in the migration: `outboxSchema('<svc>_event_outbox')` and `inboxSchema(…)`. Copy the SQL text into the file.
- **Triggers.** SQLite `RAISE(ABORT, …)` triggers become PL/pgSQL functions plus `CREATE TRIGGER … BEFORE UPDATE OR DELETE`.
- **Never edit a migration after it runs.** Add the next number instead. A change that drops or renames something is a `contract` migration naming its `expand` (`-- after: NNNN`), and it runs after the 7-day N-1 window.

## 3. The code: async from end to end

**The short path (SDK ≥ 0.18).**
- Keep the statements' shape. `db.prepare(text)` returns async `get`, `all`, `run` and `pluck`, with the same `?` and `@name` parameters, so `q.x.get(id)` becomes `await q.x.get(id)`.
- Keep functions that run inside a transaction calling `db`. With ambient transactions, `db.transaction(fn)()` becomes `await db.tx(async () => fn())`, and every `db` call inside joins it.
- What still needs a person is the SQL itself (the table below) and `lastInsertRowid`, which needs `RETURNING`.


| better-sqlite3 | openvibe-sdk/db |
|---|---|
| `db.prepare(q).get(a)` | `await db.maybe(sql\`… ${a}\`)` (or `one` when absence is a bug) |
| `db.prepare(q).all(a)` | `await db.many(sql\`…\`)` |
| `db.prepare(q).run(a)` / `.changes` | `await db.exec(sql\`…\`)` returns the count |
| `info.lastInsertRowid` | `INSERT … RETURNING id` with `db.one` |
| `db.transaction(fn)()` | `await db.tx(async (t) => { … })`: with ambient transactions (default) `db` calls inside join it; `t` also works |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | `INSERT … ON CONFLICT (key) DO UPDATE SET …` (and `excluded.col` works) |
| `datetime('now')`, `strftime(…)`, `CURRENT_TIMESTAMP` | `now()`, `to_char(…)`, `extract(epoch from …)` |
| `IFNULL`, `GROUP_CONCAT`, `json_extract(x,'$.a')` | `COALESCE`, `string_agg`, `x->>'a'` |
| `LIKE` (case-insensitive for ASCII in SQLite) | `ILIKE`, or `lower(col) LIKE lower($1)` with an index |
| `LIMIT ? OFFSET ?` on large lists | keyset: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3` |
| a loop of single-row `SELECT`s | one query with `= ANY(${ids})` or a `JOIN` |
| a loop of single-row `INSERT`s | `sql.insert(rows)` (up to about 1000 rows a statement) |

- **Handlers.** Make every Express handler and every function that touches data `async`, and `await` it. Errors reach the error handler: wrap routes (`asyncHandler`) or use Express 5.
- **The pooler's rules** (transaction mode). On `DATABASE_URL`, no session state: no session `SET`, no `LISTEN`, and no advisory lock held outside a transaction (`pg_advisory_xact_lock` inside a `tx` is fine). Use `DATABASE_DIRECT_URL` only for migrations and the importer.
- **Money paths** use `db.tx(fn, { isolation: 'serializable' })`. Lock the rows you debit with `SELECT … FOR UPDATE`, in a fixed order, and use idempotency keys. The layer retries serialization failures.
- **Readiness.** Report `await db.ready()` (it names `postgresql`) and `await valkey.ready()` in `/ready`, so it never claims a store from configuration.
- **Boot.** `await createDb({ url: process.env.DATABASE_DIRECT_URL }).migrate({ dir })`, closed afterwards. Then `createDb({ service })` for serving. The advisory lock makes this safe when several processes start together.

## 4. Per-process state goes to Valkey

Anything held in a process that must be shared once there are two processes:
- **Per-actor limits:** `createActorLimiter({ …, store: createValkeyLimitStore(valkey) })`.
- **Caches** (maps, LRUs): `createCache({ valkey, namespace })`, with TTLs and tags.
- **Realtime fan-out** (a message received by one process must reach sockets on another): `createPubSub({ valkey })`.
- **Background work run from `setInterval`:**
  - If it must run once across processes, it becomes a `createQueue` job, or a job claimed with a lease row (`UPDATE … SET lease_until = … WHERE … FOR UPDATE SKIP LOCKED`).
  - A purely local chore (pruning a process's own memory) may stay a timer.
- **Nothing authoritative.** Money, accounts, grants, bans and entitlements live only in PostgreSQL.

`createValkey()` returns `null` without `VALKEY_URL`, and every module above then runs in-process. Tests need no Valkey unless they test sharing.

## 5. Tests

- **Per test, run real PostgreSQL:** `const db = createDb({ pglite: true }); await db.migrate({ dir })`. Keep test data in the same shape as before, then fix what the types change (booleans, parsed JSON, ISO timestamps).
- **What to add:**
  - a test that the hot routes run a bounded number of queries;
  - a migration test (the files parse, apply in order, and apply twice without change);
  - an import test that imports a small SQLite fixture with `importSqlite` and checks `report.ok`.
- **CI** starts the containers and runs the suite against them (`test: 'eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm test'`, as the SDK does) when the service has pooler-sensitive code.
- **Skipping:** a test that cannot run something prints `<label>: skipped (<why>)`, and the shared runner reports it.

## 6. The one-time import, and the production switch

Add `scripts/migrate-to-postgres.js`, a few lines around `runSqliteMigration` from `openvibe-sdk/db` (SDK ≥ 0.19; Wiki's is the example). It:
1. runs the migrations with `DATABASE_DIRECT_URL`;
2. runs `importSqlite({ sqlite: <the service's DB path>, db: owner, truncate: true, tables: { … dropColumns … } })`;
3. prints the report and exits 1 unless `report.ok`.

It changes nothing in the SQLite file.

1. **Rehearse** on a copy of the production database:
   - copy it (`sqlite3 <db> ".backup /tmp/rehearsal.db"` as the service user, then move it off the host) or use the drill copy;
   - run the script against a PGlite or local container database;
   - fix every problem it reports: dropped columns must be dropped on purpose, and dates it cannot read must be mapped;
   - record the per-table counts.
2. **In production:**
   1. `sudo /opt/openvibe.host/roles/data/add-service.sh <svc>`.
   2. Merge the PostgreSQL release, but do not deploy it yet.
   3. Stop writes: `systemctl stop openvibe-<svc>` for a short stop, or the service's read-only switch when it has one.
   4. Back up the SQLite file.
   5. Run the script from the new release's directory, as the service user, with the service's environment (Host's recipe: guarded `export`, output filtered). It must end with `report.ok`.
   6. Deploy the release (`sudo ovhost deploy <svc>`); it now reads `DATABASE_URL`.
   7. Verify that `/ready` shows `store: postgresql`, the service's own smoke checks pass, and the error rate stays flat.
3. **Keep the SQLite file read-only for 7 days** (the N-1 window). It is the rollback: redeploy the previous release, which reads it, after the owner accepts losing the writes made since the switch, or replaying them from the PostgreSQL side. After the window, archive it to B2 (`ovhost archive push`) and delete it.
4. **Record the evidence** in the same change:
   - the import report (tables, rows, checksums);
   - `/ready` before and after;
   - the test counts;
   - `STATUS.json` (the database) and the README (Depends on: PostgreSQL and Valkey);
   - the roadmap plan's WS-X2 migration list.

**Rehearsing on the containers.** An embedded PGlite can break on very large rows (OpenVibe.AI's run payloads). When `--pglite` reports every table empty, import into a schema of the containers: `createTestDb({ migrations, store: 'pg' })`, then `importSqlite({ sqlite, db: t.db })`.

## 7. Lessons from the first migrations

- **Tips (2026-09-28)** is the reference: its `postgres` branch has the schema, the importer script, `test/helpers/db.js` and the multi-process integration test. Copy them.
- **Test roles on the shared containers.** End each per-run role's backends before dropping it, or PgBouncer keeps idle server connections and exhausts the container. `test/helpers/db.js` does this.
- **Replays compare bytes.** Keep a replayed response (idempotency records) as `text`: `jsonb` reorders keys.
- **Claim an Idempotency-Key before running the handler**, with `INSERT … ON CONFLICT DO NOTHING RETURNING`. That way two concurrent requests with the same key run once.
- **Clean text PostgreSQL refuses.** SQLite text can hold NUL and unpaired surrogates. Clean them in the importer's `map`, and report each column that needed it.
- **pub/sub without Valkey.** `createPubSub` has no local fallback when Valkey is down. A hub that must keep delivering on one process falls back to local delivery itself.
- **News (2026-09-28)** added these:
  - **`rowid` tiebreaks.** `ORDER BY created_at, rowid` meant insertion order. A random ULID `id` is not, within one millisecond. Add `seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE` to the table and order by `seq`. The importer fills it in the source's row order.
  - **Scalar `MAX(a, b)` / `MIN(a, b)`** are `GREATEST` / `LEAST`.
  - **`ON CONFLICT … DO UPDATE SET x = COALESCE(excluded.x, x)`** is ambiguous in PostgreSQL. Qualify the target: `COALESCE(excluded.x, <table>.x)`.
  - **Work after the commit.** A `setImmediate` after a synchronous better-sqlite3 transaction ran after the commit. Around an async transaction it does not. Use `db.afterCommit(fn)` (SDK ≥ 0.20).
  - **The inbox.** `createInbox` (better-sqlite3) becomes `createPgInbox`, awaited. Its `idempotency_receipts` table goes in `migrations/0001_initial.sql` (`inboxSchema()`), not an unawaited `ensureSchema()`.
  - **A script run as a child process in tests** cannot reach the test's PGlite. Call the function it wraps in-process, and `node --check` the script.
- **Deals, Coupons, Trade and Reviews (2026-09-28)** added these:
  - **Higher-order wrappers.** A helper that takes a function (`conflictGuard(fn)`, `unique(fn)`, `staffAction(fn)`, a batch) must `await fn()`. Otherwise its `try` catches nothing and the caller races the write. Match PostgreSQL's error codes (`23505` unique, `23503` foreign key) with `err.table` and `err.detail`, not SQLite's message.
  - **Per-process counters around a transaction** (`batchDepth++ … finally batchDepth--`) break once requests interleave. Keep per-call state in `AsyncLocalStorage`.
  - **Factories stay synchronous.** A factory that seeded a row at construction became `async`, and every caller got a promise. Write such rows lazily on first use.
  - **SQL.** Name aliases are not allowed in `HAVING`: repeat the aggregate. A bare column next to `MAX()` in a `GROUP BY` takes its value from the max row in SQLite; use `DISTINCT ON … ORDER BY` instead. `SELECT DISTINCT` over a `LEFT JOIN` with `ORDER BY lower(x)` fails; use `WHERE … OR EXISTS (…)`. Cast a parameter tested only with `IS NULL` (`@p::bigint IS NULL`). Give a recursive CTE's seed the column's type and collation (`?::text COLLATE "C"`). `json_each(?)` becomes `jsonb_array_elements_text(?::jsonb)`.
  - **Values.** `jsonb` columns come back as objects, so do not `JSON.parse` them.
  - **Gauges.** A metrics `collect()` is synchronous. Read the database one scrape behind.
  - **`npm run test:pg` finds races PGlite hides.** PGlite has one connection, so an unawaited write finished before the next read. On a pool it does not.
- **Events (2026-09-28)** added these:
  - **A loop that read and then claimed in one synchronous step** (a delivery worker's "select due rows, mark them busy") can now run twice at once, from a timer and a kick, and send the same row twice. Serialize the passes: a call during a pass waits for one more pass after it.
  - **Register before the first `await`.** A connection counted against a cap, or joined to an in-process fan-out, after its catch-up queries lets the cap overrun and loses what was published meanwhile. Take the slot and join first; buffer live rows until the catch-up ends, then send those it did not cover.
  - **A function passed as an argument** (`flush(insertBatch)`) is async now; the codemod does not see through parameters. Await it by hand.
  - **No DDL at boot.** A module that ran `CREATE TABLE IF NOT EXISTS` on the serving handle fails on production roles (`permission denied for schema`) while PGlite allows it. The table goes in the migration; `sqlfix.py` reports `db.exec(`.
  - **Test boots that call `start()` directly** fall back to the development PGlite directory and share rows across runs. Pass every boot a `createTestDb` handle.
  - **Redaction.** PostgreSQL has no `secure_delete`: an overwritten row version stays until vacuum. Lower the table's `autovacuum_vacuum_scale_factor` and say so in the README.
- **Community (2026-09-28)** added these:
  - **A schema changed by `migrate()` after `SCHEMA`.** `gen-migration.js --open "require('./server/db').openDb(':memory:')"` takes the schema the SQLite release's own boot leaves (every ALTER applied, tables in dependency order, boot seeds as INSERTs). Run it before converting any code.
  - **SQLite text timestamps.** `DATETIME` columns hold `'YYYY-MM-DD HH:MM:SS'` text. Keep it: the migration gets `SQLITE_DATE_FUNCTIONS` (`ov_now()`, `datetime(t, modifier)`, `julianday(t)`), and `sqlfix.py` rewrites `CURRENT_TIMESTAMP` to `ov_now()` (PostgreSQL's would be a `timestamptz`, cast to different text).
  - **Type affinity.** SQLite stores text in an `INTEGER` column without complaint (a Chat room id); PostgreSQL refuses. Check the production copy (`tools/asyncify/typecheck.js <file>` lists columns holding another storage class) and read the code that writes each id column.
  - **`INTEGER PRIMARY KEY REFERENCES …`** is the other row's key, not a counter: `bigint PRIMARY KEY` (the converter does this now).
  - **camelCase aliases** fold to lower case (`AS totalViews` comes back as `totalviews`): quote them (`sqlfix.py` does).
  - **Explicit ids** into a `GENERATED ALWAYS` identity need `OVERRIDING SYSTEM VALUE` (`sqlfix.py` adds it where the migration says ALWAYS); `.lastInsertRowid` needs `RETURNING id`.
  - **`IMMEDIATE` transactions.** A read-then-write that relied on SQLite's write lock (a vote recount) locks its row first: `SELECT … FOR UPDATE`.
  - **Work kicked from inside a transaction** (`setImmediate(drain)`) runs before the commit now and misses the row: `db.afterCommit`, and a short delay when changes made together should go out as one pass.
  - **Event handlers that became async** (a WebSocket dispatch) can overtake each other: queue them in arrival order.
  - **Fire-and-forget helpers** (`tell(fn) { try { fn(x) } catch {} }`) catch nothing once `fn` is async: await it.
  - **Tests**: `const x = createFoo(…)` instances, `require('./x').fn()` calls and a test's own `rejects(promise)` helper are handled by the codemod now; a boot helper that re-requires the server gets its database passed in (`createApp({ db })`); SQLite-only upgrade tests (a `migrate()` rebuilding an old table) go, the migration ledger replaces them.
