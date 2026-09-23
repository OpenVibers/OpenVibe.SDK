# OpenVibe.SDK

> Supported browser and server clients for the OpenVibe platform.

**Status:** alpha, v0.3.1 (roadmap Wave 2; developer apps from Wave 20). Tested against local stub servers and the built-in mock platform only, never against the live platform. Several OpenVibe services pin v0.2.2; OpenVibe.Examples uses 0.3.0.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §3.2; roadmap §30.  
**License:** MIT ([LICENSE](LICENSE)). This package is a library that apps outside the network embed, so it uses MIT. The OpenVibe services themselves stay AGPL-3.0.

**If a capability is not in the SDK, it is not public.** Apps call services through `openvibe-sdk` and never build internal routes themselves. A route with no SDK wrapper is internal, even when you can reach it, and it can change without notice. To make a capability public, first define it in OpenVibe.Contracts, then wrap it here.

```bash
npm install https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.3.1
```

It has no runtime dependencies. It needs Node ≥ 20, or any browser with `fetch`, Web Crypto and `TextDecoder`. There is no build step. The package is CommonJS with ESM entry points (`import` works). Each subpath has its own `.d.ts`. For a page with no bundler, `browser/openvibe-sdk.mjs` is one self-contained ES module of the browser-safe subpaths (see [Browser without a bundler](#browser-without-a-bundler)). It does not depend on `openvibe-contracts`: it copies the contract types it uses (from Contracts v0.28.0, checked in CI).

## Quick start

### Browser app (signed-in user)

```js
import { createClient } from 'openvibe-sdk/core';
import { startAuthorization, readCallback } from 'openvibe-sdk/auth';     // browser build: PKCE only
import { createCommunityClient } from 'openvibe-sdk/community';
import { subscribe } from 'openvibe-sdk/realtime';

// Sign in: send the browser to the Network with a PKCE challenge.
const { url, state, codeVerifier } = await startAuthorization({ clientId: 'my-app', redirectUri: 'https://my.app/auth/callback' });
sessionStorage.setItem('ov_pkce', JSON.stringify({ state, codeVerifier }));
location.assign(url);

// On /auth/callback: check state, then hand the code and verifier to YOUR server (see below).
const saved = JSON.parse(sessionStorage.getItem('ov_pkce'));
const { code } = readCallback(location.href, { expectedState: saved.state });
await fetch('/auth/exchange', { method: 'POST', body: JSON.stringify({ code, codeVerifier: saved.codeVerifier }) });

// Call services as the signed-in person (Network session cookie).
const client = createClient({ credentials: 'include' });
const community = createCommunityClient(client);
const { pastes } = await community.pastes.list({ limit: 20 });

// Live updates, resumable across reloads.
const sub = subscribe(['live.stream.*'], (event, { seq }) => render(event), {
    client, lastEventId: localStorage.getItem('seq'), onGap: () => refetchEverything(),
});
```

**The token exchange happens on your server.** First-party clients and confidential developer apps have a client secret, and a secret must never reach a browser. A public developer app has no secret, but its server should still do the exchange and keep the token in an HttpOnly session. The browser entry points contain no exchange code. A test scans every file a browser bundle can reach (and the browser bundle itself) and fails on `client_secret`, `node:` imports, `require('crypto')` or `process.env`.

### Server service (service principal)

```js
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient, exchangeCode, verifyUserToken } = require('openvibe-sdk/auth');
const { createEventsClient } = require('openvibe-sdk/events');
const { createIdentityClient } = require('openvibe-sdk/identity');

const tokens = createServiceTokenClient({ clientId: 'live', clientSecret: process.env.OV_CLIENT_SECRET });
const client = createClient({
    tokenProvider: tokens,                                    // one cached token per audience (openvibe.events, openvibe.media, …)
    baseUrls: { network: 'http://127.0.0.1:4000', events: 'http://127.0.0.1:4300' },   // same-host services; others come from discovery
});

// Continue the incoming request's trace on every outbound call.
app.use((req, _res, next) => { req.ov = client.fromRequest(req); next(); });

const events = createEventsClient(client, { source: 'live' });
await events.publish({ event_type: 'live.stream.started', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '12' } });

const who = await createIdentityClient(client).resolve({ system: 'live', id: 123 });   // -> { subject, username, … } | null

// The browser's /auth/exchange from above:
const t = await exchangeCode({ code, codeVerifier, redirectUri, clientId: 'my-app', clientSecret: process.env.OV_OAUTH_SECRET });
const claims = await verifyUserToken(t.access_token, { jwks: 'https://openvibe.network/api/.well-known/jwks', audience: 'openvibe.network' });
claims.subject_id;   // usr_…
```

### External developer (a developer app)

Developer apps belong to a project on OpenVibe.Network ([developer projects](https://github.com/OpenVibers/OpenVibe.Network/blob/main/docs/developer-projects.md)). An app is a principal `app_<ULID>`: `confidential` (has a secret, may use client credentials) or `public` (no secret, authorization code + PKCE only), in `sandbox` or `production`. Its tokens last 5 minutes, carry one audience, the approved capabilities (`cap`), `project_id`, `env` and `ns: [project_id]`, and there are no refresh tokens.

A server app with a secret and a grant (here `media.object.upload`) uploads into its project's Media namespace:

```js
const sdk = require('openvibe-sdk');

const tokens = sdk.auth.createServiceTokenClient({ clientId: process.env.OV_CLIENT_ID, clientSecret: process.env.OV_CLIENT_SECRET });
const client = sdk.createClient({ tokenProvider: tokens });
await client.discover();                                   // origins + contracts version from https://openvibe.network/.well-known/openvibe
const { scope, unverifiedClaims } = await tokens.getTokenInfo({ audience: 'openvibe.media' });   // what Network granted (display only)
const media = sdk.media.createMediaClient(client, { app: unverifiedClaims.project_id });           // Media tenancy is the project id
const file = await media.upload(fs.readFileSync('logo.png'), { filename: 'logo.png', contentType: 'image/png' });
file.public_url;   // https://openvibe.media/f/<key>
```

The token's `env` picks the tenant: a sandbox app's files go to the project's sandbox tenant (`app_id: '<prj_…>-sandbox'`) and are never served publicly. Media answers them with `sandbox: true`, a signed, expiring `url` and `url_expires_at`; the client adds `signed_url` (the same URL) and sets `public_url` to `null`. Uploading and deleting need `media.object.upload`, listing and getting `media.object.read`.

App events (`events.app.publish | read | subscribe`) live under the project's own topic `app.<project_key>.*` (`project_key` = `p` + the lowercased project ULID) with `source: app-<lowercased app ULID>`. `createAppEvents()` fills that in, and scopes pulls and subscriptions to the project:

```js
const { createAppEvents } = require('openvibe-sdk/events');
const events = createAppEvents(client, { projectId: unverifiedClaims.project_id, appId: process.env.OV_CLIENT_ID });
await events.publish({ event_type: 'order.shipped', subject: { type: 'order', id: 'o1' }, payload: { n: 1 } });
//   -> app.p01k5….order.shipped, source app-01k5…, actor { type: 'app', id: 'app_…' } (onBehalfOf: the person instead)
const page = await events.pull({ topic: 'order.*', platformTopics: ['live.stream.*'], afterSeq });   // + public first-party events
await events.subscribe({ topicPattern: '*', endpoint: 'https://hooks.example.com/openvibe' });        // public https only
```

Events keeps sandbox and production apart: a sandbox app sees and receives only its project's sandbox events (and public first-party ones), a production app only production ones. Realtime (SSE) never streams app events; pull or subscribe. `projectKey(projectId)` and `appSource(appId)` are exported for code that builds envelopes itself.

"Sign in with OpenVibe" for an app: the code yields an app token that acts for the person (`on_behalf_of: usr_…`).

```js
const { startAuthorization, readCallback, exchangeCode, verifyAppToken } = require('openvibe-sdk/auth');

// /login: capability ids as scope, and the audience the token is for.
const { url, state, codeVerifier } = await startAuthorization({ clientId, redirectUri, audience: 'openvibe.media', scope: ['media.object.read'] });
// /callback:
const { code } = readCallback(req.url, { expectedState: state });
const t = await exchangeCode({ clientId, clientSecret /* omit for a public app */, code, codeVerifier, redirectUri, audience: 'openvibe.media' });
t.refresh_token;   // undefined: when it expires, the person signs in again

// A service receiving app tokens verifies them offline:
const claims = await verifyAppToken(token, { jwks: 'https://openvibe.network/api/.well-known/jwks', audience: 'openvibe.media' });
claims.project_id; claims.env; claims.on_behalf_of;   // env=sandbox is refused (token.sandbox_refused) unless acceptSandbox: true
```

Manage projects, apps, secrets and grants with `openvibe-sdk/projects` and a Network user token:

```js
const projects = require('openvibe-sdk/projects').createProjectsClient(sdk.createClient({ token: userAccessToken }));
const prj = await projects.create({ name: 'My app' });
const app = await projects.apps.create(prj.id, { name: 'server', environment: 'sandbox', type: 'confidential' });
app.credential.client_secret;   // shown ONCE: store it now
await projects.grants.request(prj.id, app.id, 'media.object.upload');
```

Run a Tools job and follow it across disconnects and restarts:

```js
const jobs = require('openvibe-sdk/jobs').createJobsClient(client, { baseUrl: 'https://img.openvibe.tools' });
const { job } = await jobs.submit({ type: 'img.process', input: { tool: 'convert', format: 'webp' }, files: [{ name: 'a.png', data: bytes }], idempotencyKey });
for await (const e of jobs.events(job.id, { lastEventId: saved })) saveId(e.id);     // reconnects with Last-Event-ID
const res = await jobs.file(job.id, 0);                                              // raw Response
```

`test/testing.test.js`, `test/apps.test.js`, `test/app-events.test.js`, `test/mock-services.test.js`, `test/projects.test.js` and `test/jobs.test.js` run these flows end to end against `openvibe-sdk/testing`. What the live platform allows today (sandbox audiences, allowances, which capabilities are grantable) is in the Network doc above and in OpenVibe.Examples' README.

## API

| Subpath | Where | What |
|---|---|---|
| `openvibe-sdk/core` | both | `createClient()`, `OpenVibeError`, `paginate()`, `offsetPager()`, trace and id helpers, `CONTRACTS_RANGE` |
| `openvibe-sdk/auth` | server (browser build: PKCE only) | `createServiceTokenClient()` (+ `getTokenInfo()`), `verifyUserToken()`, `verifyAppToken()`, `exchangeCode()`, `refreshUserToken()`; `startAuthorization()`, `buildAuthorizeUrl()`, `createPkcePair()`, `pkceChallenge()`, `readCallback()`, `decodeUnverified()`, `unverifiedClaims()` |
| `openvibe-sdk/registry` | both | `createRegistryClient(client)`: `services({status})`, `service(id)`, `capabilities({owner})`, `capability(id)`, `namespaces()`, `contracts()`, `topics()`, `domain(host)`, `descriptor()` |
| `openvibe-sdk/identity` | server | `createIdentityClient(client)`: `resolve({subjectId} \| {system,type,id})`, `resolveBatch({subjectIds} \| {system,type,ids})` |
| `openvibe-sdk/modules` | both | `createModulesClient(client)`: `get`, `put(ns, data, {revision})`, `delete`, `list`, `update(ns, fn)`, `publicGet`; `forSubject.get/put/update` for services |
| `openvibe-sdk/events` | server | `createEventsClient(client, {source})`: `publish`, `prepare`, `pull`, `iterate`, `get`, `get/setCheckpoint`, `subscriptions.create/list/get/disable/enable` (`subscribe`), `deliveries`, `replay`; `verifyDelivery`, `signDelivery`, `parseDelivery`; developer apps: `createAppEvents(client, {projectId, appId, onBehalfOf?})` (same calls, scoped to `app.<project_key>.*`), `projectKey`, `appSource`; `createOutbox`, `createInbox` |
| `openvibe-sdk/realtime` | both | `subscribe(topics, onEvent, {lastEventId, onGap, …})`, `createRealtimeClient(client)`, `parseSSE(body)` |
| `openvibe-sdk/media` | both (credentials: server) | `createMediaClient(client, {app, apiKey?, actingUserId?})`: `files.upload/list/iterate/get/delete`; `mediaUrls(origin)` public URL helpers |
| `openvibe-sdk/community` | both | `createCommunityClient(client, {actingSubject?, origin?, sourceRef?, staff?})`: `pastes.list/iterate/get/create/update/delete/fork/like/copy/versions/byUser/config`, `pastes.comments.list/create/delete`, `as(subject)` |
| `openvibe-sdk/jobs` | both | `createJobsClient(client, {baseUrl?})`: `submit` (Idempotency-Key), `get`, `cancel`, `events` (SSE, reattaches), `wait`, `file` (raw Response); `isTerminal()` |
| `openvibe-sdk/projects` | both (user token) | `createProjectsClient(client)`: `catalog`, `list`, `create`, `get`, `update`, `archive`, `setAllowance`, `setEnvironmentPolicy`, `members.*`, `apps.*`, `credentials.list/rotate/revoke`, `grants.list/request/approve/deny/revoke`, `quotas.*`, `audit`, `iterateAudit` |
| `openvibe-sdk/testing` | Node | `createMockPlatform()`: fake Network (incl. developer apps and projects), Events, Media and Tools jobs on an in-process `fetch` |
| `openvibe-sdk/browser/openvibe-sdk.mjs` | browser | one self-contained ES module: core + auth (browser), registry, modules, realtime, media, community, jobs, projects |

Server-only subpaths are declared `"browser": null` in the exports map, so a bundler refuses them in a browser build and doesn't ship them by accident.

### How every call behaves (`core`)

- **Where it goes.** Name a `service` and a `path`. The origin comes from `baseUrls[service]`, or from the registry: `discover()` reads `<network>/.well-known/openvibe` and caches it for 5 minutes, and concurrent callers share one fetch. Use `baseUrls` for host-internal addresses such as `/internal/*` routes on `127.0.0.1`.
- **Version negotiation.** The descriptor includes the contracts release the network runs. `discovery.compatible` says whether it falls within `CONTRACTS_RANGE` (`>=0.5.0 <1.0.0` for this release). By default an out-of-range version logs one warning. With `strictContracts: true` it throws `sdk.incompatible_contracts`. `client.supports(id)` checks whether a service is registered and running.
- **Deadlines.** `timeoutMs` (default 10 s) applies to each attempt and covers reading the body. `deadlineMs` (default 30 s) bounds the whole call, retries included. An `AbortSignal` cancels the call.
- **Retries.** A call is retried (default `retries: 2`, exponential backoff with jitter, `Retry-After` honoured) on network errors, timeouts, 408, 425, 429, 502, 503 and 504, and only when repeating it is safe:
  - GET, HEAD, OPTIONS, PUT and DELETE are always safe to repeat.
  - Any other method is retried only with an `Idempotency-Key`. When `retries > 0`, the client generates one for each mutation (`idem_<ULID>`) and sends the same key on every attempt.
  - `idempotencyKey: false` turns this off for writes the server does not dedupe. The Community wrappers do that for create, fork, like, copy and comment.
  - `idempotent: true` marks a mutation the server dedupes by itself. Events publishing does, because Events dedupes on `event_id`.

  A 401 invalidates the token once and repeats the call with a fresh one.
- **Errors.** Every failure is an `OpenVibeError` with `code`, `status`, `title`, `detail`, `requestId`, `traceId`, `errors` and `problem`:
  - RFC 9457 problems keep their `code`.
  - OAuth errors become their `error` (`invalid_client`).
  - Legacy `{ error: 'text' }` bodies become `http.<status>`.
  - Failures with no HTTP response use `sdk.timeout`, `sdk.deadline_exceeded`, `sdk.aborted`, `sdk.network_error` or `sdk.unknown_service`.
- **Tracing.** Every call sends `traceparent` and `X-OpenVibe-Request-Id`. The request id stays the same across retries. `client.withContext({ traceparent, requestId })` or `client.fromRequest(req)` continues the caller's trace with a new span. The `traceparent` option also accepts a getter, for example one backed by AsyncLocalStorage.
- **Pagination.** `paginate(fetchPage, { cursor })` is an async iterator over `{ items, next }` pages. Media and Community use offsets. Events `iterate()` walks `after_seq` and calls `onPage(page)` only after every item of that page was handled, so saving `page.next_after_seq` there is crash-safe.
- **Streams and downloads.** `responseType: 'response'` resolves with the raw fetch `Response` (`data` and `response`, body unread). Error statuses are still read and thrown. The timeout covers the headers only, and `signal` still cancels the body. `parseSSE(res.body)` (from `openvibe-sdk/realtime`) iterates a `text/event-stream`.

### Auth details

- `createServiceTokenClient()` follows the rules of openvibe-contracts `serviceAuth.createTokenClient()` but needs no dependencies. It sends `POST /oauth/token` with `grant_type=client_credentials`, `audience` and an optional `scope`, which can be a string, an array, or a map from audience to scope. It keeps one cached token per audience until 60 s before expiry and shares one in-flight request. As a `tokenProvider`, each call gets a token for the audience of the service it calls: `openvibe.<service>` by default, or the value in `audiences` if you set one.
- `verifyUserToken(token, { jwks, issuer, audience })` checks a token offline:
  - It accepts RS256 only. `alg: none`, HS256 and anything else fail as `token.malformed` before any key is used.
  - It checks the signature against the JWKS document or URL. A URL is cached for 6 h and fetched again when a token carries an unknown `kid`. It also accepts the Network's legacy `public_key` field or a PEM string.
  - It checks `exp`, `nbf` and `iat` (30 s clock skew), then `iss` and `aud`.
  - It rejects service-principal tokens (`token.not_user`).

  It returns the claims, including `subject_id`.
- `verifyAppToken(token, { jwks, issuer, audience, acceptSandbox })` checks a developer app's token the way openvibe-contracts (v0.26 and later) `verifyServiceToken()` does: the same signature and time rules, the audience (required), `actor_type: app`, the claim shape (`sub app:app_…`, `cap`, `jti`, `project_id prj_…`, `env`, optional `on_behalf_of usr_…`), and `env: sandbox` refused as `token.sandbox_refused` unless `acceptSandbox: true`. Opt in only when your service keeps sandbox traffic apart from real data. It does not check capabilities: test `claims.cap` for the one your route performs.
- `exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret?, audience?, scope? })`: without `clientSecret` (a public app) the PKCE verifier is required; `app_…` clients must send the verifier and an `audience`. App tokens come back without a `refresh_token`.
- `startAuthorization()` / `buildAuthorizeUrl()` default `scope` to `'profile theme'` only for first-party sign-in (no `audience`). Apps pass `audience` and capability ids. Network refuses `prompt=none` for apps.
- `createServiceTokenClient().getTokenInfo({ audience })` returns `{ accessToken, scope, expiresAt, unverifiedClaims }`. `decodeUnverified()` / `unverifiedClaims()` decode a JWT without verifying it: for display and diagnostics, never for authorization.
- PKCE follows RFC 7636 S256. The verifier is 64 characters from the unreserved set, and the challenge is `BASE64URL(SHA-256(verifier))`. Network verifies the verifier whenever the authorization carried a challenge, and requires S256 from every developer app.

### Testing your app

```js
const { createMockPlatform } = require('openvibe-sdk/testing');
const platform = createMockPlatform({
    clients: { 'my-service': { secret: 's', grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: ['my-app'] }] } },
    apps: { 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR': { env: 'production', type: 'confidential', secret: 's', redirectUris: ['http://localhost:3009/callback'], grants: ['media.object.upload'] } },
    mediaApps: { 'my-app': {} },
    users: [{ username: 'ana' }],
    jobs: true,
});
const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR', clientSecret: 's', fetch: platform.fetch }) });
```

The mock answers at the real public origins with real RS256 tokens and checks audience, capability, namespace and sandbox the way the services do. It covers:

- **Network:** discovery, `/oauth/token` (client credentials, authorization code with PKCE, refresh; developer apps), `GET /oauth/authorize` (consents automatically as `setAuthorization({ subjectId })`, or declines with `{ decision: 'deny' }`), the JWKS, the registry, `/api/v1/projects` (projects, members, apps, credentials, grants, quotas, audit), `/api/modules` and `/internal/modules`, and `/internal/identity`.
- **Developer apps:** `apps` / `projects` options, `addApp()`, `signAppToken()`. App tokens carry `sub app:…`, `cap`, `ns: [project_id]`, `project_id`, `env` and `on_behalf_of` (code flow); codes are single use, PKCE-bound and bound to the `audience` given at authorize; a sandbox app of a project with members can be authorized only by them. The capability catalog is the public + active capabilities of openvibe-contracts v0.28.0 (`DEFAULT_APP_CATALOG`, `events.app.*` included).
- **Sandbox:** as in production, Media (on `/api/v1/<project_id>/files`) and Events (on the `events.app.*` routes) accept sandbox app tokens and keep their data apart from production; every other route and mock service refuses `env: sandbox` tokens (`401 token.sandbox_refused`) unless `acceptSandbox` lists the audience or capability. Unlike Network, sandbox apps get tokens for any audience unless you pass `sandboxAudiences`, and projects created through the API start with the whole catalog as allowance unless you pass `defaultAllowance: []`.
- **Events:** publish with `event_id` dedupe, pull (with a `gap` after `pruneEvents(seq)`), checkpoints, subscriptions, `/realtime/stream` SSE with `Last-Event-ID` and gap events, and a delivery worker: `deliverEvents()` / `startDeliveries()` POST signed deliveries to your local endpoint in order, retry, and mark them dead after `max_attempts`. Developer apps follow OpenVibe.Events' rules: app tokens are judged only on `events.app.publish | read | subscribe`; types `app.<project_key>.<name…>`, source `app-<ulid>`, actor the app or its `on_behalf_of` user; reads, checkpoints and subscriptions limited to the own project in the token's env plus public first-party events (every pattern starts with a literal segment, `app.*` patterns name the own key); app endpoints https and not loopback, private or local names; first-party readers never see sandbox events and see app events only through `app.*`; realtime streams neither. Not modelled: per-project quotas, revocation, and the DNS half of the endpoint check. Your delivery worker's `fetch` (`deliverEvents({ fetch })`) can route `https://hooks.example.com/…` to a local server.
- **Media:** the files API and `GET /f/:key`, with Media's tenant rules: `media.object.upload` uploads and deletes, `media.object.read` lists and gets (app keys, service tokens and app tokens alike); a developer app reaches only `/api/v1/<its project_id>/files`, where production uses the tenant `prj_…` and sandbox `prj_…-sandbox` (100 MB, `mediaQuotaMb`); sandbox files come back as `{ sandbox: true, url: <signed>, url_expires_at }` and `/f/<key>` serves them only with a valid signature.
- **Tools jobs** (`jobs: true | { stepMs, handlers }`) at `origins.tools` and the satellites `img.`, `audio.` and `docs.openvibe.tools` (`platform.toolsOrigins`; `toolsSatellites` overrides), each with its own jobs: submit with Idempotency-Key replay, get, cancel, SSE with `Last-Event-ID` and `204` when finished, result files; `dropJobStreams()` simulates a dropped connection.

Helpers: `signUserToken()`, `signServiceToken()`, `signAppToken()`, `authorize()`, `setAuthorization()`, `publishEvent(envelope, publisher, { projectId, env })` (a registered app's `app:<id>` publisher implies them), `pruneEvents()`, `deliverEvents()`, `dropRealtime()`, `dropJobStreams()`, and `stats` and `state` for assertions. It is a fake. It has no persistence, its visibility rules are simplified, and it has no Chat (no WebSocket mock).

### Browser without a bundler

```html
<script type="module">
  import { createClient, auth, registry } from '/vendor/openvibe-sdk.mjs';   // copied or served from node_modules/openvibe-sdk/browser/
  const { url, state, codeVerifier } = await auth.startAuthorization({ clientId, redirectUri, audience: 'openvibe.media', scope: ['media.object.read'] });
</script>
```

`browser/openvibe-sdk.mjs` is generated by `node scripts/browser-bundle.js` from the CommonJS sources reachable from `browser.js` (no dependencies, no transpiling) and checked in. It exports core at the top level and `auth` (browser build), `registry`, `modules`, `realtime`, `media`, `community`, `jobs` and `projects` as namespaces. `test/bundle.test.js` fails when it is stale, and the browser secret scan covers it.

## Versioning

- `openvibe-sdk` follows semver. While it is 0.x, a minor release may break an API, and [CHANGELOG.md](CHANGELOG.md) says so. Pin a tag.
- Each release states the openvibe-contracts range it was tested against (`CONTRACTS_RANGE`), and `discover()` checks it at runtime. Contract types are copied into `types/contracts.d.ts`. `test/types.test.js` fails if they differ from the pinned Contracts release. CI clones `OpenVibe.Contracts` at the pinned tag for this check.
- A new public capability ships as a minor release: first the contract, then the wrapper here, then the service's route. Removing a wrapper is a major release, after the capability's deprecation window in Contracts has passed.

## Not wrapped yet (intentionally)

- **Community comments on other content, the forum and Pulse** are being built in Community right now. Only paste comments are wrapped. The rest is a TODO in `src/community.js` until those APIs settle.
- **Media v2 objects** (`med_` ids, ADR-006, `/api/v2/:app/objects`) exist on Media but are not wrapped yet. This release wraps only the v1 files API, plus the public URL helpers. VOD, clip, thumbnail and admin-storage routes are not wrapped because apps reach them only through Live and Media's own servers. Media's own paste API is not wrapped because pastes moved to Community (ADR-011).
- **Media from the browser:** Media refuses user JWTs on `/api/v1/:app/files`, so a browser uploads through its own app server. That server holds the app key and names the user with `actingUserId`.
- **Network coins, notifications and legacy-map writes** are internal service-to-service routes with no public capability, so they are not wrapped. Staff-only paste routes are also internal: admin stats, bulk, censor and the AI pass.
- **Chat, Live, Billing and Games** from the original charter come when those services publish their capabilities in Contracts. Chat has no app principal (`chat.message.send` is `first-party`), so there is no Chat client and no Chat mock.
- **Tools job types** are not wrapped one by one: `openvibe-sdk/jobs` submits any `type` with its `input` and files; each satellite (img, audio, docs) documents its own types.
- **Realtime over WebSocket and presence** don't exist in Events yet (ADR-005). SSE is the only transport.

## Development

```bash
npm test                                 # every test/*.test.js: stub servers + mock platform, then npm pack + install
fnm exec --using=22.22.1 npm test        # the Node version production runs
node scripts/esm.js                      # regenerate esm/*.mjs after changing a module's exports
node scripts/browser-bundle.js           # regenerate browser/openvibe-sdk.mjs after changing a browser-safe file
```

Style: CommonJS, 4-space indent, single quotes, semicolons. Browser-safe files use only `fetch`, `Headers`, `FormData`, `Blob`, `URL`, `TextEncoder`/`TextDecoder` and `globalThis.crypto` (Web Crypto). Server-only files may use `node:` modules and are marked `"browser": null` in `package.json`.

## Owns / does not own

Owns the supported client surface, version negotiation and feature detection, and the mock adapters for development. It doesn't own service implementations, and it doesn't own UI components (OpenVibe.Shared). It replaces the hand-written per-repo clients: Live's `media-client`, Community's proxies and Tools' fetch helpers.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
