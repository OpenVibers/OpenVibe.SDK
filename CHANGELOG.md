# Changelog

All notable changes to `openvibe-sdk`. The package follows semver; while it is `0.x`, a minor
release may change an API and says so here.

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
