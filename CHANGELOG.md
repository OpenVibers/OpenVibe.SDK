# Changelog

All notable changes to `openvibe-sdk`. The package follows semver; while it is `0.x`, a minor
release may change an API and says so here.






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
