# Changelog

All notable changes to `openvibe-sdk`. The package follows semver; while it is `0.x`, a minor
release may change an API and says so here.






## 0.26.0 (2026-10-01)

- `openvibe-sdk/service` (new, server; plan T1): the service kit. `gracefulStop({ name, server, stop, close, drainMs = 4000,
  deadlineMs = 5000, deadlineExitCode = 1, signals = true, exit, log, beforeDrain, handles })` → `{ stop(signal?),
  stopping() }` and `within(ms, promise)`: OpenVibe.Network's and OpenVibe.Community's `server/graceful.js` (stop steps,
  then `server.close` with `Connection: close` on requests in flight, idle connections closed every 50 ms and event streams
  destroyed, then close steps, exit 0; one stop per process), plus the exit code of a blown deadline (the 5 s family and
  Media exit 0), `beforeDrain` and `handles` (closed last; a failure exits 1). Its deadline timer is not `unref()`'d, so a
  step stuck on a promise ends in the deadline's exit code rather than a quiet exit 0. The error layer: `createServiceError(name)`,
  `ServiceError`, `asServiceError(err, { publishing, map })`, `run(fn, status)`, `wrap(fn)`, `sendError(res, req, err, log)`,
  `jsonBody({ limit = '512kb' })` (malformed: 400 `request.invalid_json`; too large: 413 `request.too_large`),
  `privateNoStore(res)` and the opt-in `jsonErrors()`, with Reviews/Wiki's defaults and `extra` spread (or `extra: 'details'`
  for Tips/VIP). `createReadiness`, `skip`, `safeReason`, `createRegistry`, `instrument`, `metricsHandler`, `isLoopbackDirect`,
  `releaseInfo`, `createRelease` (openvibe-shared) and `problem`, `sendProblem` (openvibe-contracts) are re-exported, required on
  first use from the service's own packages: the SDK gains no dependency. Recipe per family: `docs/service.md`.
- `scripts/esm.js`: a getter on a CommonJS entry (a lazy re-export) becomes an ESM function that reads it on call, so
  importing `openvibe-sdk/service` loads neither package.

## 0.25.2 (2026-09-29)

- `openvibe-sdk/realtime` follows Events' opaque cursors (ADR-042): it resumes from the last SSE id exactly as Events
  sent it (a cursor, or a seq from an older Events) and dedupes on the `seq` in the message data. With cursor ids the
  previous release parsed the id as a number, so its resume position and repeat filter stopped advancing.
  `subscription.lastEventId` is now that raw id (a string).

## 0.25.1 (2026-09-29)

- `verifyServiceToken({ jwks })` also takes a JWKS client the service already holds (`jwksClient(url)`, or one a test
  injects), so a service that built one for `openvibe-sdk/sso` verifies service tokens with the same keys, chosen by
  `kid`, instead of taking the first key itself.

## 0.25.0 (2026-09-29)

- `openvibe-sdk/sso` (new, server): `createSsoClient({ site, baseUrl, clientId, clientSecret, networkUrl, networkInternalUrl,
  secureCookies })` → `router(express)` (`/login`, `/callback`, `/fedcm`, `/logout`, `/me`, `/refresh`), `optionalAuth()`,
  `requireAuth()`, `verify()`, `extractToken()`. A product site's sign-in with OpenVibe.Network in one call: state and PKCE
  S256 on every sign-in, the code exchanged server-side, `next` limited to this site and the Network, offline verification
  through the shared JWKS client. Replaces the copies in Blog, Coupons, Deals, Host, News and Trade (plan T1).
- `openvibe-sdk/events` `createServiceOutbox({ db, source, eventsUrl, clientId, clientSecret, eventTypes, validate })`: a
  service's events outbox in one call around `createPgOutbox` (`emit` joins the change's transaction, `emitIn(t, …)`,
  `moderationAction`, `start`/`stop`/`kick`/`status`); the relay is off, and says so, without the events URL or the
  client secret. Replaces the wrapper nine services copied (plan T1).
- No floating promises (plan T0): the Valkey queue logs a job whose run rejects outside its handler (a malformed stream
  entry was an unhandled rejection), and the mock jobs service fails a job whose background run throws.

## 0.24.0 (2026-09-29)

- `openvibe-sdk/auth` `verifyServiceToken(token, { jwks | publicKey, issuer, audience, contracts, acceptSandbox, log })`:
  a service or app token for a service that receives them. The SDK picks the key (the one the `kid` names, else each,
  from the shared JWKS client or a pinned PEM); every rule is the service's own pinned openvibe-contracts
  `serviceAuth.verifyServiceToken`, passed in as `contracts`, so the SDK carries no copy of the rules. No key is
  `token.unavailable` with the fixed reason 'signing key not loaded yet' (the fetch error goes to `log`). Replaces the
  hand-written kid-and-contracts loop in AI, Search, Sources, Games and Codes (plan T1).
- `verifyUserToken` refuses a typed token (`typ` or `purpose` set: Network's realtime ticket, a FedCM assertion) as
  `token.not_user`: it is never a session, whatever its issuer and audience say. Network's session tokens carry neither.

## 0.23.1 (2026-09-29)

- The release version is whole again: `SDK_VERSION` and the browser bundle say 0.23.1 (0.23.0 shipped them at 0.22.0,
  so version, bundle and pack tests failed on its tree).
- JWKS: a malformed entry in `keys` (null, a non-object) is skipped instead of marking the whole key set failed; a
  legacy document with only `public_key` no longer refetches every 30 s for a token that names a kid.
- Types: `log` is declared on the verify options (it is passed to the JWKS client).

## 0.23.0 (2026-09-29)

- **JWKS client** (`openvibe-sdk/auth`: `jwksClient(url, opts)`, `createJwksClient`, `jwksStatus()`), now behind `verifyUserToken`/`verifyAppToken` for a JWKS URL (plan T0/T1: one refresher instead of hand-written copies that swallowed errors). Keys stay fresh for 6 h; after that the last good keys are served while one refresh runs in the background, and a failed fetch keeps them and backs off (1 s doubling to 5 min) instead of rejecting sign-ins or hammering Network. A token with an unknown `kid` refetches at once (a rotation is honoured immediately); unknown-kid refetches are spaced 30 s apart, so a flood of made-up kids costs one fetch per 30 s. Only state changes are logged (`log` option: the first failure, the recovery). `status()` / `jwksStatus()` report readiness, staleness, failures and the next try for `/api/ready`; `start({ intervalMs })` refreshes in the background on an unref'd timer. Before: an expired cache plus a failed fetch rejected every token with 503, and each unknown kid forced a refetch.

## 0.22.0 (2026-09-28)

- **`openvibe-sdk/placement`** (roadmap WS-Z9, the adaptive fabric): `plan(requirements, offers, { rateCards, states, current })` places a workload on the best eligible node or provider and explains it (platform.placement-result@1). Hard constraints first (capabilities, trust, residency, health, latency ceiling, capacity, cost ceiling; excluded candidates carry the reason), then the objective (cheapest, lowest-latency, balanced; private and first-party-only never leave first-party capacity; critical work stays with its authority). `marginalCost` prices work in a provider's real billing unit after its free allowance, forecast to the end of the period, with a reserve kept for high-priority work; owned capacity is ~free until its binding resource is busy, then work spills over. Hysteresis keeps a placement unless an alternative is clearly better (15% by default); failover is immediate. `rendezvous` (weighted highest-random-weight hashing), `pickTwo` (power of two choices), and Ed25519-signed route plans: `signPlan`, `verifyPlan`, `createPlanHolder` (keeps the last valid plan when a new one is bad, expired or older).
- **`openvibe-sdk/govern`** (roadmap WS-Z1): weighted cost units (common.resource-cost@1) with quotas per subject and tier over minute, hour, day and month windows; `reserve` → `commit(actual)` or `release`, settled by any process; idempotency keys so a retried charge counts once; concurrency leases. Valkey holds the counters (atomic Lua); without Valkey they live in the process.

## 0.21.3 (2026-09-28)

- `openvibe-sdk/testing` `createTestDb`: on the containers it also returns `url` and `directUrl`, the `DATABASE_URL` and `DATABASE_DIRECT_URL` of its schema, for a test that spawns a process of the service (OpenRe's transport workers); `null` on PGlite.
- `tools/asyncify/sqlfix.py`: the outbox-envelope rewrite no longer nests on a second run.

## 0.21.2 (2026-09-28)

- `openvibe-sdk/events` outboxes (SQLite and PostgreSQL): a `flush()` called while a relay pass runs now gets the next pass, which starts when that one ends. It used to share the running pass, so it could return before the rows committed after that pass claimed were published (a caller's "flush, then assert both went out" saw one). Calls made during a pass share that next pass; `stop()` waits for both.
- `scripts/test-services.sh`: PgBouncer closes idle server connections after 5 s and takes at most 120 per database, and PostgreSQL allows 200. Each test process has a role of its own, so the pools of a suite with many files ran PostgreSQL out of connections.

## 0.21.1 (2026-09-28)

- `openvibe-sdk/events` `createPgOutbox`: the relay publishes the rows it claimed in the order they were written. `UPDATE … RETURNING` gives no order, so a batch could reach Events out of order (a `media.clip.failed` before the `media.vod.ready` written before it). Found converting OpenVibe.Media.

## 0.21.0 (2026-09-28)

- `openvibe-sdk/auth`: `createPgRevocationStore(db, { table })` keeps Network's per-person token cutoffs on PostgreSQL. `await load()` reads them into memory at boot, so `isRevoked()` and `cutoffFor()` stay synchronous on the request path; `apply()` and `record()` are async and write through before memory moves, never backwards (a later cutoff stored by another process wins). `revocationSchema(table)` is its table, for the service's migration (the SQLite store created its table at first use, which a PostgreSQL runtime role cannot do).
- `openvibe-sdk/valkey`: the client no longer runs iovalkey's ready check (`INFO`), which a service's ACL user may not call; every connect logged NOPERM. `ready()` still pings.

## 0.20.4 (2026-09-28)

- `openvibe-sdk/db`: `bytea` comes back as a `Buffer` from both adapters. PGlite returned a `Uint8Array`, so `Buffer.isBuffer` and `.toString('hex')` differed between tests and production. Found with openvibe-shared's config store on PostgreSQL. `test/db-ambient.test.js`.

## 0.20.3 (2026-09-28)

- `importSqlite` reads the target tables of the connection's current schema, not only `public`. A per-run test schema from `createTestDb({ store: 'pg' })` works now, so a rehearsal can use the containers. Production is unchanged: its search path is `public`.
- Rehearsal note: an embedded PGlite (`--pglite`) can break on very large rows. OpenVibe.AI's `runs` did, while the same import verified on PostgreSQL. When `--pglite` reports every table empty, rehearse on the containers instead (`docs/migrating-to-postgresql.md` §6).

## 0.20.2 (2026-09-28)

- **`importSqlite` refuses a source table that has no target table.** Before, such a table was skipped without a word. A table that a module created at runtime and the migration forgot would have been dropped by the switch (found converting OpenVibe.AI: `subject_credentials`). SQLite's own tables and FTS5 virtual tables with their shadow tables are still skipped, because an index is rebuilt, not copied. Anything else not imported on purpose goes in the new `skipSource` option, also on `runSqliteMigration`. An audit of the eleven services already switched found nothing lost. `test/db.test.js`.

## 0.20.1 (2026-09-28)

- **`openvibe-sdk/db`: one query at a time per transaction connection.** `await Promise.all(xs.map((x) => db.….get(x)))` inside a transaction used to put several queries on the transaction's client at once. node-postgres queues them, but warns that pg@9 will refuse. Such calls are now chained per connection, in call order. Outside a transaction, each call still takes its own pool connection and runs concurrently. `test/db-ambient.test.js` checks this on PGlite and through PgBouncer.

## 0.20.0 (2026-09-28)

- **`db.afterCommit(fn)`** (and `t.afterCommit(fn)` on a transaction handle) runs `fn` once the running transaction commits. It never runs after a rollback, and a savepoint that rolls back drops the hooks added inside it. Hooks run in order, outside the transaction, with the connection already back in the pool; one that throws is logged and the rest still run. Outside a transaction, `fn` runs on the next turn. It replaces the better-sqlite3 pattern of a `setImmediate` after a synchronous transaction, for calls to other services that must see committed state (News' comment-thread visibility was the first user).
- **`db.stats().open`**: transactions in progress on this handle.
- `tools/asyncify` gains `sqlite-schema-to-pg.js` (a service's SQLite DDL → `migrations/0001_initial.sql`) and `g1pass.py` (the non-codemod edits of a Blog-shaped service). `asyncify.js` now treats `{ name: someAsyncFunction }` as an async method `name`. None of these are in the published package.

## 0.19.0 (2026-09-28)

- **`openvibe-sdk/db` `runSqliteMigration({ service, sqlite, directUrl, migrations, tables, argv })`** is a service's `scripts/migrate-to-postgres.js` in one call. It:
  - applies the migrations as the owner, or on an in-memory PGlite with `--pglite` for a rehearsal;
  - imports with `importSqlite` into emptied tables;
  - makes text PostgreSQL refuses storable (a NUL is dropped, an unpaired surrogate becomes U+FFFD, in text and inside JSON), and reports every column where that happened;
  - verifies counts and checksums, prints the report (`--json` for all of it), and answers 0 only when everything verified.

  It was generalised from Tips' script and first used by Wiki. `test/sqlite-cli.test.js`.

## 0.18.1 (2026-09-28)

- **`db.prepare`:** a statement with one parameter takes a single array argument as that parameter's value (`WHERE id = ANY(?)`). Only statements with several parameters read a single array as the list of values (better-sqlite3's array form). Found converting OpenVibe.Wiki.
- **`openvibe-sdk/testing`:**
  - `createTestDb({ migrations, store, service })` gives a migrated database for one test run. It is PGlite by default. With `store: 'pg'` (or `OV_TEST_STORE=pg`) it runs on the containers, with roles and a schema of its own shaped as the host's `add-service.sh` makes them.
  - Setup and teardown take an advisory lock, so parallel runs never race on the catalog ("tuple concurrently updated").
  - `open()` gives a second pooled handle, and `close()` ends the roles' backends and drops them.
  - `createTestValkey({ prefix })` gives the containers' Valkey under a prefix of its own.
  - Every service's copied test helper is replaced by these.

## 0.18.0 (2026-09-28)

This release makes the move from better-sqlite3 mostly mechanical: call sites keep their shape and gain `await`.

- **`openvibe-sdk/db`: ambient transactions** (on by default; `createDb({ ambient: false })` turns them off).
  - Inside `db.tx(fn)`, plain `db.*` calls join the running transaction through AsyncLocalStorage. So do `db.prepare` statements and library stores that were handed `db`. Their writes are visible inside the transaction, roll back with it, and never wait on it.
  - A `db.tx` inside is a savepoint.
  - A promise the transaction did not await runs on the pool once it has ended.
  - `db.detached(fn)` leaves the transaction on purpose, and `db.inTransaction()` tells whether code is inside one.
  - The handle `fn` receives works as before.
- **`db.prepare(text)`**: async statements shaped like better-sqlite3's.
  - Methods: `get` (a row or `undefined`), `all`, `run` (`{ changes, rows, lastInsertRowid }`; the id needs `RETURNING`) and `pluck()`.
  - Parameters: `?`, or `@name`/`:name` from one object (a repeated name is one parameter).
  - The compile to `$n` leaves `'…'` strings, `"…"` identifiers, dollar quotes, comments and `::` casts alone.
- Tests: `test/db-ambient.test.js`, on PGlite and through PgBouncer.
- `importSqlite` verification treats a JSON `null` and SQL NULL as equal. JSON text `'null'` imported into `jsonb` had failed its checksum (found in the Tips migration).
- The guide gains a section of lessons from the Tips migration: `SUM(bigint)` returns a numeric string, test roles through PgBouncer, byte-exact replays, idempotency claims, NUL and surrogate cleaning, and pub/sub without Valkey.

## 0.17.0 (2026-09-28)

- **`openvibe-sdk/geo`** (browser and server): `createGeoClient(client, { samples?, timeoutMs? })` finds the closest OpenVibe node (roadmap WS-X1 task 5).
  - `nodes({ role?, region? })` reads Network's public node registry, `GET /api/v1/nodes` (`network.node-list-result@1`), without sending a token.
  - `measure(nodes)` times each node's beacon several times (the best sample counts, since the first also pays for DNS and TLS) and returns the nodes fastest first.
  - `nearest({ role?, region?, preferRegion? })` returns the fastest measured node that is up or degraded. When nothing can be measured, it falls back to `preferRegion`, then to the first healthy node, and returns `measured: false`.
- The root export and the browser bundle include `geo`. The root export also includes `openre`.

## 0.16.0 (2026-09-28)

- **`openvibe-sdk/openre`** (server): `createOpenReClient(client, { baseUrl?, publicUrl?, playbackTtlMs? })`, the client for OpenRe.Stream, the platform's streaming engine. Products stop carrying their own copy, starting with OpenVibe.Live.
  - `streams`: `list`, `byExternalRef`, `create`, `get` (null when missing), `update`, `delete`, `keys`, `rotateKey`, `destinations` and `addDestination`.
  - `destinations`: `update`, `delete`, `test`, `start`, `stop` and `logs`.
  - `sessions`: `list`, `get` (null when missing), `playback` (cached 10 s), `end` and `outputs`.
  - Also `outputLogs`, `workers` and `manageUrl`.
  - Every call uses a service token for `openvibe.openre`. `{ subject }` names the person a call acts for (`X-OV-Subject`).

## 0.15.0 (2026-09-28)

**The event outbox and inbox on PostgreSQL** (ADR-004 on ADR-035), in `openvibe-sdk/events`. The better-sqlite3 versions stay for services that have not moved yet.
- **`createPgOutbox(db, { events })`:** takes an openvibe-sdk/db handle.
  - `enqueue(t, envelope)` takes the transaction handle, so the event exists if and only if the change commits.
  - The relay claims due rows with a lease (`FOR UPDATE SKIP LOCKED`), so any number of processes and hosts relay one table without sending an event twice. A relay that dies leaves its rows to the next one once the lease expires.
  - Otherwise it behaves as before: backoff on transient failures, permanent refusals isolated per row, the seq kept, `pending`, `rejected` and `prune`.
- **`createPgInbox(db)`:** `once(consumer, eventId, async (t) => …)` runs the handler once, in one transaction with its receipt, and a failed handler leaves no receipt.
- **`outboxSchema()` and `inboxSchema()`:** the DDL to put in a service migration, since the runtime role cannot create tables.
- **Quieter tests:** the slow-query log is off by default on PGlite, whose first query includes its WASM start.
- **Tests:** `test/pg-outbox.test.js` runs on PGlite, and through PgBouncer with three relays sharing one table (60 events, none sent twice).

## 0.14.0 (2026-09-28)

**The async data layer and Valkey modules** (ADR-035 and its amendment; roadmap WS-X2): every service moves to PostgreSQL 18 and Valkey, async-first.
- **`openvibe-sdk/db`:**
  - **Queries:** `createDb({ url | pglite, service })` has `query`, `many`, `maybe`, `one`, `value` and `exec` on a safe `sql` tagged template: every value is a bind parameter, fragments nest, and `sql.ident`, `sql.set`, `sql.insert`, `sql.join` and `sql.json` help build them.
  - **Transactions:** `tx(fn, { isolation, retries })` retries 40001 and 40P01 with backoff, and nested `t.tx()` calls are savepoints.
  - **Health:** `ready()` reports the store that actually answered, with the pool state. There are metrics (`db_query_seconds`, pool gauges) and a slow-query log that shows text only, never values.
  - **Adapters:** node-postgres, which production uses through PgBouncer in transaction mode, and PGlite for tests (real PostgreSQL in-process). Both return the same rows: int8 as Number (refused beyond 2^53), timestamps as ISO strings, dates as `YYYY-MM-DD`, numeric as exact text, json parsed.
- **Migrations:** `db.migrate({ dir })` runs numbered SQL files labelled `expand`, `migrate` or `contract`. It records them in a ledger with checksums, refuses edited or out-of-order files, serialises runs with an advisory lock, holds a contract migration until its expand is 7 days old (the N-1 window), and supports `-- no-transaction`.
- **`importSqlite()`:** the one-time move of a service's SQLite file into its PostgreSQL schema.
  - Tables go parents first, and values are converted by target type (0/1 to boolean, text or epoch to timestamptz, JSON text to jsonb, JSON arrays to arrays).
  - Identity values are kept and sequences advanced. A source column that would be lost is refused unless dropped on purpose.
  - Streamed verification compares counts and content checksums.
- **`openvibe-sdk/valkey`:** the shared connection. It is auto-pipelined, confined to `VALKEY_PREFIX`, has a `duplicate()` for blocking consumers, and `ready()`.
- **`openvibe-sdk/cache`:** `getOrSet` loads a key once across processes (single-flight plus a short lock), with tags, TTLs and an in-process fallback. A cache error never fails the caller.
- **`openvibe-sdk/queue`:** at-least-once jobs on Valkey streams. It has consumer groups, retries with exponential backoff, a dead-letter stream, delayed jobs, a 24-hour dedupe by id, and reclaiming of a job a dead or hung worker holds. It also has an in-process twin.
- **`openvibe-sdk/pubsub`:** fan-out across processes and hosts, inside the prefix.
- **`openvibe-sdk/limits`:** `createValkeyLimitStore(valkey)` makes every process and host count an actor together, in one atomic script per request. If Valkey fails, that request is counted in-process instead.
- **Dependencies:** `pg`, `@electric-sql/pglite`, `iovalkey` and `better-sqlite3` are optional peers, loaded only by the module that needs them.
- **Tests:** `scripts/test-services.sh up` starts PostgreSQL 18, PgBouncer and Valkey 9 in containers, and `test/db.test.js` and `test/valkey.test.js` run against them when their URLs are set. Otherwise they run on PGlite and the in-process stores, and print skip lines.

## 0.13.0 (2026-09-28)

**Deliveries are v2 only**, as OpenVibe.Events sends them since 2026-09-28 (the v1 header, a replayable HMAC of the body alone, is retired: shim C-60). `signDeliveryHeaders` returns `X-OpenVibe-Timestamp` and `X-OpenVibe-Signature-V2` only, and the mock platform's `deliverEvents` sends no `X-OpenVibe-Signature`. A consumer test that asserted the v1 header must drop that assertion. `signDelivery` and `verifyDelivery` stay for testing a legacy receiver, and `parseDelivery` still accepts a v1-only delivery unless `requireV2`, which every production consumer sets.

## 0.12.0 (2026-09-28)

**`openvibe-sdk/limits`** (roadmap WS-R task 4): per-actor rate limits at a service's capability boundaries, where nginx can only limit by address. `createActorLimiter({ limits: { minute, hour, day } })` returns `limits(name, ownLimits)`, Express middleware that counts each actor in fixed windows and refuses past a limit with 429 problem+json (`rate_limited`, `Retry-After` from the tightest exceeded window) before the route runs.
- The actor is the verified principal (`svc:live`, `app:…`), else the signed-in person (`user:<subject>`), else `ip:<address>`; `actor(req)` overrides it, and null skips counting.
- A route's limits replace the defaults window by window.
- Counters are per process and bounded (`maxActors`, oldest dropped first), and `onLimited` observes refusals.
Node only. Additive.

## 0.11.0 (2026-09-25)

Two more clients (roadmap WS-F task 4). **`openvibe-sdk/chat`**: OpenVibe.Chat over REST as the token's person: `global.send/history/search`, `rooms.list/create/get/update/messages/send/deleteMessage/join/leave/read/members/setMember`, `dms.list/create/get/messages/send/deleteMessage/read/unread/blocks/block/unblock`, `exportMine()`; writes are never retried, a room or conversation you may not read is `null`. **`openvibe-sdk/ai`**: OpenVibe.AI's run API: `runs.create(workflow, input, { wait, version, idempotencyKey, target, attribution, onBehalfOf, options })`, `runs.get/list/cancel/retry/citations/addCitations`, `runs.waitFor(id)` (polls until succeeded, failed or cancelled), and the direct operations `chat/generate/summarize/classify/extract/enrich/embed`; a create is retried only with an idempotency key. Both in the browser bundle, ESM and types. Additive.

## 0.10.0 (2026-09-25)

**`openvibe-sdk/search`** (roadmap WS-F task 4): OpenVibe.Search's query API. `createSearchClient(client)` gives `query(text, { owner, type, lang, filter, facets, limit, cursor })` (one page: `results`, `next_cursor`, optional facet counts), `iterate(text, opts)` (every result across cursor pages, `max` to stop early), `suggest(text)` and `document(owner, type, id)` (null when missing or not yours to see). Anonymous callers get public documents; a signed-in person also gets restricted documents naming them; a first-party service with `search.query.delegate` passes `actingSubject`. Several values of one facet go as repeated `facet.<key>` parameters. In the browser bundle too. Additive.

## 0.9.1 (2026-09-24)

The v0.9.0 tag reports `SDK_VERSION` 0.8.0 and ships a stale browser bundle; 0.9.1 is the same API with both right. Use 0.9.1.

## 0.9.0 (2026-09-24)

`openvibe-sdk/auth` **`createRevocationStore(db?)`**: token cutoffs from Network's `network.user.token_valid_after` (Contracts 0.39.0), so a service refuses a person's older tokens as soon as they sign out everywhere, change their password or are banned. `apply(event)`, `isRevoked(claims)`, `cutoffFor(subject)`, `record()`; SQLite-backed or in memory. Additive.

## 0.8.0 (2026-09-24)

`openvibe-sdk/frame`: **the OpenVibe Frame**, the navbar, footer and themes every OpenVibe site sits in, for any app, first-party or not. It covers:

- the universal navbar: one account menu, notifications, the site switcher, and sign in and out through your own session endpoints (`sessionUrl`, `loginUrl`, `logoutUrl` with `{path}`/`{url}`);
- the shared footer, with network and legal links, the "shipped X ago" line and an Updates link;
- the theme loader.

These are the same files every OpenVibe site runs, served by OpenVibe.Network from the published openvibe-shared release, so nothing is bundled into your app.

`mountFrame(opts)` loads and mounts them in the browser. It never throws for a network failure; a part that cannot load resolves to `null`. `frameTags(opts)` returns the same markup as strings for server-rendered pages, with the configuration escaped for its `<script>`. `frameConfig` and `scriptUrls` are exported for custom setups. The base must be an https origin (or `http://localhost` in development). Browser-safe; no dependencies.

## 0.7.0 (2026-09-24)

`openvibe-sdk/vip`: the consumer seam for products that honour OpenVibe.VIP memberships
(`createVipClient`, `createVipCache`), published once here instead of the verbatim copies of VIP's
`openvibe-vip/client` that Chat, Community and Blog carried. Server-only (`"browser": null`); the
same API and fail-closed behaviour: VIP unreachable, a timeout, a refused token or a malformed answer
is a denial, a refused token is invalidated and retried once, and the cache drops a member's answers
for a creator on `vip.membership.changed` (and Billing's entitlement, cancellation and reversal
events) instead of waiting out its TTL. Additive.

## 0.6.0 (2026-09-23)

The OpenVibe.Tools platform API (ADR-027, openvibe-contracts v0.33.0) as `openvibe-sdk/tools`, and
retry and result references in `openvibe-sdk/jobs`. The Tools routes are being built: the registry
(`GET /api/v1/tools…`) comes with Tools S3, the run API and the gateway's `/api/v1/jobs` facade with
Tools S6. Until they are deployed this client is tested against the contracts and the mock only.

- **`createToolsClient(client, { baseUrl?, service = 'tools', audience = 'openvibe.tools', anonymousReads = true })`**
  -> `{ list, get, schema, run, jobs }`, on the gateway (the `tools` origin from the platform
  descriptor unless `baseUrl` is given). Also in `index.js`, `browser.js`, the ESM entry
  (`esm/tools.mjs`) and the browser bundle (`tools` namespace).
  - `list({ family, q, execution, api, status })` answers `tools.tool-list@1` (schemas as `$ref`);
    `get(id)` the descriptor (`tools.tool@1`, schemas embedded); `schema(id)` `{ $schema, $id,
    $defs: { input, output } }`. Both are `null` on 404. Registry reads send no token unless
    `anonymousReads: false`.
  - `run(id, input = {}, { files, waitMs, idempotencyKey, signal, timeoutMs })` posts
    `tools.run-request@1`. An inline tool, or a job that finished within `waitMs`, resolves to
    `{ state: 'succeeded', tool, result: { data | text | files }, took_ms, job?, location? }`. A job still
    queued or running (202, or a replay) resolves to `{ state, tool, job, location }`. Both carry
    `idempotencyKey` and `replayed`, and a non-enumerable `wait(opts)`: a finished run resolves to
    itself, and a job follows its events (`jobs.wait`) to the succeeded run.
  - A run that finished `failed` or `cancelled` throws **`ToolRunError`**, an `OpenVibeError` (same
    `name`, `isOpenVibeError` is true) carrying the tool's problem+json (`code`, `status` of the
    problem, `title`, `detail`, `errors`) plus `state`, `tool`, `job` and `run`; `isToolRunError()`.
    A request refused before the tool ran (404 `tools.tool.not_found` | `not_runnable`, 422
    `tools.input.invalid`, 401/403, 429, 503 `tools.tool.unavailable`) is a plain `OpenVibeError`.
  - The `Idempotency-Key` is always sent (generated when omitted), so the core client retries a
    429 after its `Retry-After`, and 5xx, with the same key: a job is created once. `timeoutMs` per
    attempt is raised to `waitMs`, or to the tool's `limits.timeoutMs` once this client has read its
    descriptor, plus 10 s.
  - **Files**: uploads in the jobs client's shapes (a Blob/File, or `{ name, data, type? }`) go as
    multipart `file` parts; references `{ media_id }` (a Media object you may read) and
    `{ job_id, index }` (a result file of your own job) go in the JSON body's `files`, or, beside
    uploads, as a multipart `files` part holding their JSON. The tool gets uploads first, then
    references. Bad references are a `TypeError` before anything is sent.
  - `jobs` is `createJobsClient()` on the same origin and credentials (the gateway facade).
- **`openvibe-sdk/jobs`:** `retry(id)` -> `{ job, replayed }` (a failed job as a new one; asking
  again returns that same retry), `reference(id, ref)` and `unreference(id, ref)` -> the job (keep a
  succeeded result while `<service>:<kind>:<id>` points at it; `expires_at` is null meanwhile).
  **Default origin:** without `baseUrl` the jobs client uses the `tools` origin
  (https://openvibe.tools), whose gateway fronts every satellite's jobs once Tools S6 ships the
  facade. Until then pass the satellite (`baseUrl: 'https://img.openvibe.tools'`); an explicit
  `baseUrl` keeps working as before. `Job` types gain `tool`, `retry_of`, `retried_by`,
  `references` and `links.retry` / `links.retried_by`.
- **Mock platform (`openvibe-sdk/testing`):** `tools: true | { descriptors, handlers, mediaObjects, stepMs }`
  serves the registry and run routes on `origins.tools`, with the default tools `dns`, `jsonminify`,
  `png`, `port`, `yt` and `protectpdf`. It models caller tiers (probes need `tools.net.probe`, and
  job tools need a token because the mock has no browser sessions), the refusal codes, idempotent job
  runs, `wait_ms`, and file references. New: `addTool()`, `addMediaObject()`, `state.tools`. **Mock
  jobs changed** so that they answer `tools.job@1` exactly: `error` is problem+json (`type`,
  `title`, `status`, `code`, `detail`), not `{ code, detail }`; result files carry `sha256`,
  `storage: 'local'` and `media: null`. Views also gain `retry_of`, `retried_by`, `references`,
  `links.retry` and `expires_at`. Jobs now serve `POST /:id/retry` and `PUT|DELETE /:id/references/:ref`,
  and `origins.tools` acts as the gateway facade, so it also finds the satellites' jobs. A test that
  compared a failed mock job's `error` with `{ code, detail }` must compare those fields instead. The
  mock `fetch` now rejects on an aborted signal, as `fetch` does.
- **Contracts:** `openvibe-contracts` v0.33.0 is a devDependency (tarball tag pin, tests only; still no
  runtime or peer dependency). `test/tools.test.js` validates every run request and every answer
  with it. `types/contracts.d.ts` is re-copied from it: `ModuleNamespace` gains its doc comment, and
  it adds `ToolDescriptor`, `ToolList`, `ToolsRunRequest`, `ToolsRun`, `ToolsJob` and
  `ToolsJobRequest`. CI no longer clones Contracts v0.28.0.
- Types: `types/tools.d.ts` (`ToolsClient`, `ToolRunOutcome`, `ToolRunSucceeded`, `ToolRunPending`,
  `ToolRunError`, `ToolFileRef`, `ToolRunFile`, `ToolSchema`, `ToolListQuery`, `ToolRunOptions`),
  plus the jobs and testing additions.

## 0.5.0 (2026-09-23)

Media's object API v2 (`/api/v2/:app/objects`) and its jobs (`/api/v2/:app/jobs`), wrapped as
`createObjectsClient()` in `openvibe-sdk/media`. Additive: nothing existing changes.

- **`createObjectsClient({ app, baseUrl?, tokenClient | apiKey | client, … })`.** `tokenClient` is a
  `createServiceTokenClient()` (a service or developer-app principal with `media.object.upload` and
  `media.object.read` for namespace `app`; a developer app uses its project id as `app`). Options:
  `actingUserId` (X-OV-User-Id, app key only), `subject` (X-OV-Subject), `multipartThreshold` (64 MiB),
  `partSize` (16 MiB), `concurrency` (4), `hashMaxBytes` (256 MiB), `resumeRounds` (3).
- **Discovery.** Without `baseUrl`, Media's origin comes from the platform descriptor
  (`/.well-known/openvibe`). The descriptor gives an origin only for live services: when Media has
  none (not registered, or only a `planned_origin`) the client throws `sdk.service_unavailable` and
  never guesses. `objects.baseUrl()` says which origin is used.
- **`upload(data, { kind, visibility, mimeType, filename, metadata, contentHash, multipart, onProgress, signal, … })`**
  picks single or multipart by size. Single: init, then the bytes go to Media's presigned PUT URL (no
  credential on that request), then complete. Multipart (above `multipartThreshold`, with
  `multipart: true`, or when Media answers 413 `media.object.too_large` to a single part): parts go up
  `concurrency` at a time with `X-Content-SHA256`; after each round the session is read back and the
  missing parts are sent again; complete names every part's sha256. The whole object's sha256 is sent
  for Media to verify up to `hashMaxBytes`. A part that cannot be sent ends in `sdk.upload_incomplete`
  with `err.resume = { objectId, uploadId, missing }`.
- **`resume({ objectId, uploadId }, data)`** continues a multipart session, e.g. from another process:
  it reads the session with the client's credential, re-sends parts Media holds with a different sha256
  and the missing ones, and completes.
- **`get(id)`** (null on 404; `med_…` ids and legacy refs), **`signedUrl(id, { ttl })`** (`{ url,
  expires_at, public }`: a signed link for private objects), **`delete(id)`** (true, or false on 404),
  **`list(q)`** (one page) and **`iterate(q)`** (every object, newest first).
- **`jobs.create({ type, objectId, params, idempotencyKey })`**, `get`, `list`, `approve` (a proposal ->
  queued), `cancel` and `wait(id)` (polls until succeeded, failed or cancelled). Types today:
  `thumbnail.regenerate`, `invariant.scan`, `object.split`, `object.remux`.
- Types (`MediaObject`, `MediaJob`, `ObjectsClient`, `ObjectUploadOptions`), the ESM entry and the
  browser bundle include it.

## 0.4.0 (2026-09-23)

Replay protection for OpenVibe.Events webhook deliveries (signature v2). Backward compatible:
existing callers of `parseDelivery(raw, headers, secret)` and `verifyDelivery()` keep working, and
v1-only deliveries are still accepted until you opt in to `requireV2`.

- **Events sends v2.** Besides the unchanged `X-OpenVibe-Signature: sha256=<HMAC of the raw body>`,
  every delivery attempt (retries included, each with a fresh time) carries
  `X-OpenVibe-Timestamp: <unix seconds>` and
  `X-OpenVibe-Signature-V2: t=<ts>,v2=<hex HMAC-SHA256 of "<ts>.<raw body>">`.
- New `verifyDeliveryV2(rawBody, headers, secret, { toleranceSec = 300, now = Date.now() })`:
  constant-time check of the v2 signature, false when the timestamp is more than `toleranceSec`
  from `now` either way or when `X-OpenVibe-Timestamp` disagrees with `t`. Several `v2=` values
  are allowed (any one may match); a bad `toleranceSec` throws.
- `parseDelivery(rawBody, headers, secret, { requireV2 = false, toleranceSec, now })`: when a v2
  header is present it must verify and be fresh, and a bad or stale v2 returns `null` (it never
  falls back to v1); without a v2 header, v1 is accepted only while `requireV2` is false. Header
  lookup on a plain object is now case-insensitive. **Behaviour change**: a delivery that carries
  v2 is now refused when your clock is more than 300 s off Events' (keep NTP on), or when the v2
  signature does not verify even if v1 does. Conversely, once v2 verifies, v1 is not consulted:
  a test that blanks only `X-OpenVibe-Signature` on an Events delivery and expects a refusal must
  drop or break `X-OpenVibe-Signature-V2` too.
- New `signDeliveryV2(rawBody, secret, timestamp?)` and `signDeliveryHeaders(rawBody, secret,
  { now })` (the three signature headers, for tests that post deliveries to a consumer).
  `verifyDelivery` and `signDelivery` (v1) are unchanged.
- **Mock Events** `deliverEvents()` / `startDeliveries()` send v1 and v2 headers, signed afresh on
  every attempt, as production does.
- Types and ESM entry points include the new functions.

## 0.3.1 (2026-09-23)

The remaining gaps OpenVibe.Examples found, so its examples need no local stand-ins for Events or
Media. Contract types re-copied from openvibe-contracts v0.28.0 (adds `codes.app-manifest@1` as
`AppManifest`); CI checks them against that tag.

- **Events, developer apps.** New `projectKey(projectId)` (`prj_01JAB…` -> `p01jab…`),
  `appSource(appId)` (`app_01JAB…` -> `app-01jab…`) and `createAppEvents(client, { projectId,
  appId, onBehalfOf? })`: the EventsClient calls with project-relative types and patterns
  (`order.shipped` -> `app.<project_key>.order.shipped`, `*` -> `app.<project_key>.*`), the app's
  source, and the app (or the `onBehalfOf` person) as actor and default subject; `pull`/`iterate`
  take `platformTopics` for public first-party events; subscriptions and checkpoints are scoped the
  same way. Types and ESM included.
- **Media.** For a sandbox file (`sandbox: true` from Media) the client now sets `public_url: null`
  and adds `signed_url` (Media's signed, expiring `url`); it used to put the signed URL in
  `public_url`. Media's own fields (`url`, `sandbox`, `url_expires_at`, `app_id`) are passed
  through unchanged. **Behaviour change** for code that read `public_url` of sandbox files.
- **Mock Events** plays OpenVibe.Events' developer-app rules: app tokens judged on
  `events.app.publish | read | subscribe` only (sandbox accepted there); `app.<project_key>.*`
  types, `app-<ulid>` source, actor the app or its `on_behalf_of` user; reads, `get`, checkpoints
  and subscriptions limited to the own project in the token's env plus public first-party events;
  https endpoints that are not loopback, private or local names; events stored with `project_id`
  and `env`, deliveries never cross projects or environments; first-party readers and subscribers
  see no sandbox events and app events only through `app.*`; realtime streams no app events and
  refuses app tokens. Envelopes are checked against the envelope patterns (3+ segment types,
  source syntax), topic patterns against Events' syntax, and first-party services cannot publish
  `app.*`. Not modelled: per-project quotas, revocation, DNS resolution of endpoints.
- **Mock Media** follows Media's tenantAuth: `media.object.upload` uploads and deletes,
  `media.object.read` lists and gets, for app keys, service tokens and app tokens alike (service
  tokens used to be upload-only). A developer app reaches only `/api/v1/<its project_id>/files`;
  its token's env picks the tenant, `prj_…` or `prj_…-sandbox` (created on first use, 1 GB and
  100 MB, `mediaQuotaMb`), and Media's tenant-tagged keys are used. Sandbox app tokens are accepted
  there without `acceptSandbox`, as in production (**behaviour change**: the mock used to refuse
  them). Sandbox files answer with `sandbox: true`, a signed `url` and `url_expires_at`; the new
  `GET /f/:key` serves files, sandbox ones only with a valid signature (404 otherwise). Projects no
  longer get an API-key tenant in `mediaApps`.
- **Mock Tools** answers `/api/v1/jobs` at `https://img.openvibe.tools`,
  `https://audio.openvibe.tools` and `https://docs.openvibe.tools` as well as `origins.tools`
  (`platform.toolsOrigins`, `DEFAULT_TOOLS_SATELLITES`, option `toolsSatellites`); a job is found
  only on the origin that created it.
- **Mock catalog and descriptor** follow openvibe-contracts v0.28.0: `DEFAULT_APP_CATALOG` is its
  public + active capabilities (adds `events.app.*`, `codes.release.*`, `community.*`, `vip.*`),
  and the default `contractsVersion` is 0.28.0.
- Mock state: `state.events[]` entries carry `project_id` and `env`, `state.mediaTenants` is new,
  checkpoints are stored as `{ cursor, updated_at }`; `publishEvent()` stores an event of publisher
  `app:<id>` as that registered app's (project and env), or takes `{ projectId, env }`.

## 0.3.0 (2026-09-23)

Developer apps (Network developer projects, ADR-014) and the gaps OpenVibe.Examples found.
Contract types re-copied from openvibe-contracts v0.26.0 (`identity.service-token-claims@1.2.0`:
`project_id`, `env`, `on_behalf_of`); CI checks them against that tag.

- **Auth, developer apps.** `exchangeCode()` sends `audience` and `scope`, supports public clients
  (no `clientSecret`; the PKCE `codeVerifier` is then required, and always for `app_…` clients)
  and returns app tokens as they come (no `refresh_token`). New `verifyAppToken(token, { jwks |
  publicKey, issuer, audience, acceptSandbox })`: RS256, expiry, issuer, the required audience,
  the claim shape, and `env: sandbox` refused (`token.sandbox_refused`) unless `acceptSandbox`;
  returns the claims including `project_id`, `env` and `on_behalf_of`. `verifyUserToken()` is
  unchanged and still refuses app tokens (`token.not_user`).
- **Authorize URL.** `buildAuthorizeUrl()` / `startAuthorization()` take `audience`; `scope` takes
  capability ids. **Behaviour change:** the `'profile theme'` default now applies only when no
  `audience` is given.
- **Token client.** `createServiceTokenClient().getTokenInfo(ctx)` returns the granted `scope`, the
  expiry and `unverifiedClaims` (decoded, NOT verified). New `decodeUnverified()` /
  `unverifiedClaims()` helpers in `openvibe-sdk/auth` (browser build too).
- **Core.** `client.request({ responseType: 'response' })` now returns the raw fetch `Response`
  (as `data` and `response`, body unread) instead of `data: null`; error statuses are still read
  and thrown, the per-attempt timeout covers the headers only, and `signal` still cancels the body.
  `core.SDK_VERSION` is the package version again (it said 0.1.0 in 0.2.x); a test keeps them equal.
- **Realtime.** `parseSSE(body, { onRetry })` is exported: an async iterator of
  `{ event, data, id }` over a fetch body or any async iterable.
- **Events.** `iterate()` calls `onPage(page)` after every item of that page was yielded and
  handled (it used to run before the page's items), so saving `next_after_seq` there is
  crash-safe; a break or throw inside the page leaves the previous cursor. New `maxPages` option.
  **Behaviour change** for anyone who relied on the old order.
- **New `openvibe-sdk/jobs`** (browser-safe): OpenVibe.Tools jobs — `submit()` (always with an
  `Idempotency-Key`; JSON or multipart with files), `get()`, `cancel()`, `events()` (SSE that
  reattaches with `Last-Event-ID` after drops and restarts, each event once), `wait()`, `file()`
  (raw Response).
- **New `openvibe-sdk/projects`** (browser-safe; needs a Network user token): the
  `/api/v1/projects` API — projects, members, apps, credentials rotate/revoke, grants
  request/approve/deny/revoke, quotas, audit, the catalog. Calls that mint a secret or that
  Network does not dedupe are never retried.
- **Browser bundle.** `browser/openvibe-sdk.mjs` (export `openvibe-sdk/browser/openvibe-sdk.mjs`):
  one self-contained ES module of the browser-safe subpaths for pages with no build step,
  generated by `scripts/browser-bundle.js` (no dependencies) from the CommonJS sources, checked
  in, with a staleness test, and covered by the browser secret scan.
- **Mock platform.** Developer apps (`apps`, `projects`, `addApp()`, `signAppToken()`):
  confidential and public app clients, app tokens with `project_id`/`env`/`ns`/`on_behalf_of`,
  `GET /oauth/authorize` with auto-consent (`setAuthorization()`), audience-bound codes, PKCE
  required for apps, sandbox membership, `sandboxAudiences`; mock services refuse sandbox tokens
  unless `acceptSandbox` names the audience or capability; a Media tenant per project; the
  `/api/v1/projects` API. Events: `pruneEvents()` so pulls and realtime resumes report retention
  gaps; `deliverEvents()` / `startDeliveries()` play the delivery worker (signed POSTs to a local
  endpoint, in order, retries, dead after `max_attempts`). Optional Tools jobs (`jobs: true |
  { stepMs, handlers }`): submit with idempotency replay, get, cancel, SSE with `Last-Event-ID`,
  204 when finished, result files, `dropJobStreams()`. Fixed: a realtime resume with a cursor
  ahead of the stream no longer swallows the next events. Default `contractsVersion` 0.26.0; a
  `tools` origin. Not included: Chat (no WebSocket mock; OpenVibe.Examples keeps its own).

## 0.2.2 (2026-09-23)

- No peer dependency on `openvibe-contracts`: the SDK never loads it at runtime, and a peer pinned
  to one Contracts tarball made npm refuse any service on a newer Contracts release. The supported
  Contracts range is documented in the README and checked by CI.

## 0.2.1 (2026-09-23)

- Outbox: a refusal from the Network token endpoint (for example a grant not provisioned yet) is
  retried, never treated as Events rejecting the envelope.

## 0.2.0 (2026-09-23)

- `openvibe-sdk/events`: `createOutbox(db, { events })` and `createInbox(db)` — the transactional
  outbox and exactly-once inbox on the service's own better-sqlite3 handle (ADR-004), so producers
  no longer need the `openvibe-events` server package. `enqueue()` refuses to run outside a
  transaction; the relay batches, backs off on transient failures and rejects only the row a
  permanent 4xx refused. Still no runtime dependencies (`better-sqlite3` is a dev dependency).

## 0.1.0 (2026-09-22)

First release (roadmap Wave 2, implementation plan §3.2). Built and tested against
openvibe-contracts `>=0.5.0 <1.0.0` (v0.6.0).

- `openvibe-sdk/core`: `createClient()` with per-attempt timeouts and a whole-call deadline;
  retries only for idempotent methods or requests carrying an `Idempotency-Key` (generated for
  mutations when `retries > 0`, opt out with `idempotencyKey: false`); `Retry-After`; one token
  refresh on 401; RFC 9457 problems as `OpenVibeError` (`code`, `status`, `detail`, `requestId`,
  `traceId`); W3C `traceparent` + `X-OpenVibe-Request-Id` on every call, `withContext()` /
  `fromRequest()` to continue an incoming trace; `paginate()` async iterator; `discover()` reads
  `/.well-known/openvibe`, caches service origins and checks the contracts version.
- `openvibe-sdk/auth`: server `createServiceTokenClient()` (client credentials, cache per audience
  until 60 s before expiry, shared in-flight request), `verifyUserToken()` (offline RS256 against
  the Network JWKS), `exchangeCode()` / `refreshUserToken()`; browser PKCE helpers
  (`startAuthorization()`, `buildAuthorizeUrl()`, `readCallback()`).
- `openvibe-sdk/registry`: services, service, capabilities, capability, namespaces, contracts,
  topics, domain.
- `openvibe-sdk/identity` (server): `resolve()`, `resolveBatch()` (split at 500).
- `openvibe-sdk/modules`: user get/put/delete/list/publicGet with `If-Match`, `update()`
  read-modify-write retrying on 412; service `forSubject.get/put/update`.
- `openvibe-sdk/events` (server): `publish()` fills `event_id`, `timestamp`, `source`, `version`,
  `payload`, `trace_id`; `pull()` / `iterate()` with cursor and gap reporting; checkpoints;
  subscriptions; deliveries/replay; `verifyDelivery()`, `signDelivery()`, `parseDelivery()`.
- `openvibe-sdk/realtime`: `subscribe()` over SSE (EventSource or fetch stream), resume from the
  last seq, dedupe, `onGap`.
- `openvibe-sdk/media`: files upload/list/iterate/get/delete on `/api/v1/:app/files`, public URL
  helpers.
- `openvibe-sdk/community`: pastes list/iterate/get/create (text or screenshot)/update/delete/fork/
  like/copy/versions/byUser/config and paste comments, with `actingSubject`, `origin: 'ai'`,
  `sourceRef` and `staff` for services.
- `openvibe-sdk/testing`: `createMockPlatform()`, an in-process fake Network (token endpoint,
  JWKS, discovery, registry, modules, identity), Events (publish, pull, subscriptions, SSE) and
  Media files.
- Hand-written `.d.ts` per subpath; ESM entry points; MIT license.
