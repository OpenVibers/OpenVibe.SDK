# Changelog

All notable changes to `openvibe-sdk`. The package follows semver; while it is `0.x`, a minor
release may change an API and says so here.

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
