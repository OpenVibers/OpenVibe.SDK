# Changelog

All notable changes to `openvibe-sdk`. The package follows semver; while it is `0.x`, a minor
release may change an API and says so here.

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
