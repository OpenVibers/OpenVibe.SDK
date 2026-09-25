# OpenVibe.SDK

> Supported browser and server clients for the OpenVibe platform.

**Status:** alpha, v0.6.0 (roadmap Wave 2; developer apps from Wave 20; Media objects v2 from Wave 4; the Tools platform API from the 2026-09-23 tools program). v0.6.0 is not tagged yet: the install line below stays on v0.5.0 until it is. The Tools registry, run API and jobs facade it wraps are still being built in OpenVibe.Tools (see [Tools](#tools)). Tested against local stub servers and the built-in mock platform only, never against the live platform. Production services pin three releases (2026-09-23): v0.4.0 in Live, Deals, News, Reviews, Tips, Trade and VIP; v0.3.1 in Codes; v0.2.2 in Network, Media, Blog, Wiki, Coupons, Host, OpenRe.Stream and Games. OpenVibe.Examples uses v0.4.0. CI is green from `654d4b2` (it now runs `npm ci`); the runs for the v0.3.0, v0.3.1 and v0.4.0 commits failed because `better-sqlite3` was not installed.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §3.2; roadmap §30.  
**License:** MIT ([LICENSE](LICENSE)). This package is a library that apps outside the network embed, so it uses MIT. The OpenVibe services themselves stay AGPL-3.0.

**If a capability is not in the SDK, it is not public.** Apps call services through `openvibe-sdk` and never build internal routes themselves. A route with no SDK wrapper is internal, even when you can reach it, and it can change without notice. To make a capability public, first define it in OpenVibe.Contracts, then wrap it here.

```bash
npm install https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.5.0
```

It has no runtime dependencies. It needs Node ≥ 20, or any browser with `fetch`, Web Crypto and `TextDecoder`. There is no build step. The package is CommonJS with ESM entry points (`import` works). Each subpath has its own `.d.ts`. For a page with no bundler, `browser/openvibe-sdk.mjs` is one self-contained ES module of the browser-safe subpaths (see [Browser without a bundler](#browser-without-a-bundler)). It does not depend on `openvibe-contracts` at runtime: it copies the contract types it uses (from Contracts v0.33.0, a devDependency the tests check them against).

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

Run a tool, or a Tools job, and follow it across disconnects and restarts (see [Tools](#tools)):

```js
const tools = require('openvibe-sdk/tools').createToolsClient(client);
const done = await (await tools.run('webp', {}, { files: [{ name: 'a.png', data: bytes }] })).wait();

const jobs = tools.jobs;             // or createJobsClient(client): the gateway's /api/v1/jobs facade (Tools S6)
const { job } = await jobs.submit({ type: 'img.process', input: { tool: 'convert', format: 'webp' }, files: [{ name: 'a.png', data: bytes }], idempotencyKey });
for await (const e of jobs.events(job.id, { lastEventId: saved })) saveId(e.id);     // reconnects with Last-Event-ID
const res = await jobs.file(job.id, 0);                                              // raw Response
```

Until OpenVibe.Tools serves the gateway facade (Tools S6), point the jobs client at the satellite that runs the type: `createJobsClient(client, { baseUrl: 'https://img.openvibe.tools' })` (img, audio or docs).

`test/testing.test.js`, `test/apps.test.js`, `test/app-events.test.js`, `test/mock-services.test.js`, `test/projects.test.js`, `test/jobs.test.js` and `test/tools.test.js` run these flows end to end against `openvibe-sdk/testing`. What the live platform allows today (sandbox audiences, allowances, which capabilities are grantable) is in the Network doc above and in OpenVibe.Examples' README.

## API

| Subpath | Where | What |
|---|---|---|
| `openvibe-sdk/core` | both | `createClient()`, `OpenVibeError`, `paginate()`, `offsetPager()`, trace and id helpers, `CONTRACTS_RANGE` |
| `openvibe-sdk/auth` | server (browser build: PKCE only) | `createServiceTokenClient()` (+ `getTokenInfo()`), `verifyUserToken()`, `verifyAppToken()`, `exchangeCode()`, `refreshUserToken()`; `startAuthorization()`, `buildAuthorizeUrl()`, `createPkcePair()`, `pkceChallenge()`, `readCallback()`, `decodeUnverified()`, `unverifiedClaims()` |
| `openvibe-sdk/registry` | both | `createRegistryClient(client)`: `services({status})`, `service(id)`, `capabilities({owner})`, `capability(id)`, `namespaces()`, `contracts()`, `topics()`, `domain(host)`, `descriptor()` |
| `openvibe-sdk/identity` | server | `createIdentityClient(client)`: `resolve({subjectId} \| {system,type,id})`, `resolveBatch({subjectIds} \| {system,type,ids})` |
| `openvibe-sdk/modules` | both | `createModulesClient(client)`: `get`, `put(ns, data, {revision})`, `delete`, `list`, `update(ns, fn)`, `publicGet`; `forSubject.get/put/update` for services |
| `openvibe-sdk/events` | server | `createEventsClient(client, {source})`: `publish`, `prepare`, `pull`, `iterate`, `get`, `get/setCheckpoint`, `subscriptions.create/list/get/disable/enable` (`subscribe`), `deliveries`, `replay`; `parseDelivery` (v1 and v2, `requireV2`), `verifyDeliveryV2`, `signDeliveryV2`, `signDeliveryHeaders`, `verifyDelivery`, `signDelivery`; developer apps: `createAppEvents(client, {projectId, appId, onBehalfOf?})` (same calls, scoped to `app.<project_key>.*`), `projectKey`, `appSource`; `createOutbox`, `createInbox` |
| `openvibe-sdk/realtime` | both | `subscribe(topics, onEvent, {lastEventId, onGap, …})`, `createRealtimeClient(client)`, `parseSSE(body)` |
| `openvibe-sdk/media` | both (credentials: server) | `createMediaClient(client, {app, apiKey?, actingUserId?})`: `files.upload/list/iterate/get/delete`; `mediaUrls(origin)` public URL helpers; `createObjectsClient({app, baseUrl?, tokenClient \| apiKey \| client})`: object API v2 `upload` (single or multipart by size, resumable), `resume`, `get`, `signedUrl`, `delete`, `list`, `iterate`, and `jobs.create/get/list/approve/cancel/wait`; Media's origin from the platform descriptor when `baseUrl` is omitted |
| `openvibe-sdk/community` | both | `createCommunityClient(client, {actingSubject?, origin?, sourceRef?, staff?})`: `pastes.list/iterate/get/create/update/delete/fork/like/copy/versions/byUser/config`, `pastes.comments.list/create/delete`, `as(subject)` |
| `openvibe-sdk/search` | both | `createSearchClient(client, {actingSubject?})`: `query(text, {owner, type, lang, filter, facets, limit, cursor})`, `iterate(text, {…, max})`, `suggest(text, {owner, type, limit})`, `document(owner, type, id)` (null when missing or not visible) |
| `openvibe-sdk/jobs` | both | `createJobsClient(client, {baseUrl?})`: `submit` (Idempotency-Key), `get`, `cancel`, `retry`, `reference`, `unreference`, `events` (SSE, reattaches), `wait`, `file` (raw Response); `isTerminal()`. Default origin: the Tools gateway's jobs facade |
| `openvibe-sdk/tools` | both | `createToolsClient(client, {baseUrl?, anonymousReads?})`: `list({family, q, execution, api, status})`, `get(id)`, `schema(id)`, `run(id, input, {files, waitMs, idempotencyKey, signal, timeoutMs})` (+ `.wait()`), `jobs`; `ToolRunError`, `isToolRunError()` |
| `openvibe-sdk/projects` | both (user token) | `createProjectsClient(client)`: `catalog`, `list`, `create`, `get`, `update`, `archive`, `setAllowance`, `setEnvironmentPolicy`, `members.*`, `apps.*`, `credentials.list/rotate/revoke`, `grants.list/request/approve/deny/revoke`, `quotas.*`, `audit`, `iterateAudit` |
| `openvibe-sdk/vip` | server | `createVipClient({baseUrl?, tokenClient \| getToken, fetch?, timeoutMs?})`: `evaluate({subject, resource, owner, fallback, mode})`, `checkEntitlement({subject, creator, product, mode})`, `isMember(subject, creator)`; every failure is a denial. `createVipCache({vip, ttlMs, denyTtlMs, unavailableTtlMs})`: `entitlement`, `peekEntitlement`, `evaluate`, `invalidate`, `handleEvent` (`vip.membership.changed` and Billing's entitlement events drop a member's answers at once), `clear`, `bounds` |
| `openvibe-sdk/testing` | Node | `createMockPlatform()`: fake Network (incl. developer apps and projects), Events, Media, Tools jobs and the Tools platform API on an in-process `fetch` |
| `openvibe-sdk/browser/openvibe-sdk.mjs` | browser | one self-contained ES module: core + auth (browser), registry, modules, realtime, media, community, jobs, tools, projects |

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
- `createRevocationStore(db?)` keeps each person's token cutoff from Network's `network.user.token_valid_after` event (Contracts 0.39.0: sign out everywhere, a password change or reset, a ban, staff ending someone's sessions). Subscribe to the event, pass each delivery to `store.apply(event)` (`'revoked'` means the cutoff moved: close that person's sockets, drop their cached sessions), and after `verifyUserToken()` refuse the token when `store.isRevoked(claims)`. That is Network's rule, `iat * 1000 < valid_after`. With a better-sqlite3 handle the cutoffs survive restarts; the store only ever moves a cutoff forward and ignores anything not from `network`.

### Receiving event webhooks

OpenVibe.Events POSTs each delivery as `{ event, seq }` with two signatures:

- `X-OpenVibe-Signature: sha256=<hex HMAC-SHA256 of the raw body>` (v1). It covers only the body, so a captured delivery verifies forever.
- `X-OpenVibe-Timestamp: <unix seconds>` and `X-OpenVibe-Signature-V2: t=<that timestamp>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">` (v2). Every attempt, retries included, is signed with the time it is sent, so a delivery stops verifying 300 s later.

The key is the subscription secret. Verify the raw bytes, not re-serialized JSON:

```js
const { parseDelivery } = require('openvibe-sdk/events');

app.post('/internal/events', express.raw({ type: 'application/json' }), (req, res) => {
    const d = parseDelivery(req.body, req.headers, process.env.EVENTS_WEBHOOK_SECRET, { requireV2: true });
    if (!d) return res.sendStatus(401);
    inbox.once('my-service', d.event.event_id, () => { /* synchronous db writes */ });   // still dedupe: delivery is at least once
    res.sendStatus(204);
});
```

`parseDelivery(raw, headers, secret, { requireV2 = false, toleranceSec = 300, now })`:

- If `X-OpenVibe-Signature-V2` is present, it must verify and its timestamp must be within ±`toleranceSec` of `now` (ms, default `Date.now()`). A bad or stale v2 returns `null`. It never falls back to v1.
- If there is no v2 header, v1 is accepted only while `requireV2` is false (the default, so 0.4.0 changes nothing for existing callers).

Turn `requireV2` on once Events sends v2 to you: a replayed v1-only delivery then fails. The lower-level checks are `verifyDeliveryV2(raw, headers, secret, { toleranceSec, now })` (constant-time; also refuses a `X-OpenVibe-Timestamp` that differs from `t`) and `verifyDelivery(raw, signatureHeader, secret)` (v1, unchanged). Keep your clock in sync (NTP): the window is ±300 s both ways. In tests, `signDeliveryHeaders(raw, secret, { now })` returns the three headers as Events sends them.

### The OpenVibe Frame

Every OpenVibe site uses the same navbar and footer. Your app can use them too, so people move between it and the network without a jump:

```js
// Browser (CommonJS or ESM: openvibe-sdk/frame)
const { navbar } = await mountFrame({
    service: 'myapp',
    brand: { name: 'My App' },
    links: [{ label: 'Home', href: '/' }, { label: 'Docs', href: '/docs' }],
    menu: { before: [{ label: 'My projects', href: '/projects' }] },     // rows in the account menu
    sessionUrl: '/auth/me',                                              // your server session: { user }
    loginUrl: '/auth/login?next={path}',
    logoutUrl: '/auth/logout?next={path}',                               // Sign out ends your session too
    footer: { updates: '/updates' },                                     // or false for no footer
});
```

For server-rendered pages, `frameTags(opts)` returns `{ head, bodyStart, bodyEnd }`: put `head` in `<head>`, `bodyStart` first in `<body>` and `bodyEnd` last. Your CSP needs `script-src https://openvibe.network` and `connect-src https://openvibe.network`.

The Frame is progressive: if openvibe.network cannot be reached, your page still renders, and the part that failed resolves to `null`. Signed-in state comes from the shared `ov_token`, and otherwise from your `sessionUrl`. To have your users recognised across the network, sign them in with OpenVibe (`openvibe-sdk/auth`).

### Tools

`openvibe-sdk/tools` wraps the OpenVibe.Tools platform API (ADR-027, openvibe-contracts v0.33.0) on the gateway, `https://openvibe.tools`: every tool has a descriptor (`tools.tool@1`), and every tool with `api: true` runs through one route. **Status:** the registry routes come with Tools S3, the run API and the gateway's `/api/v1/jobs` facade with Tools S6 (the capabilities `tools.tool.read`, `tools.tool.run` and `tools.net.probe` stay `planned` until then). Until they are deployed, this client is tested against the contracts and the mock only.

```js
const { createToolsClient, isToolRunError } = require('openvibe-sdk/tools');
const tools = createToolsClient(client);                       // client: createClient({ … }); a token is optional

const { tools: list, count } = await tools.list({ family: 'img', api: true });   // tools.tool-list@1, schemas as $ref
const png = await tools.get('png');                            // tools.tool@1 with schemas embedded, or null
const { $defs } = await tools.schema('png');                   // { input, output }: what the $refs point at

// An inline tool (execution client with a server engine, or sync) answers finished:
const min = await tools.run('jsonminify', { text: '{ "a": 1 }' });
min.result.text;                                               // '{"a":1}'

// A job tool answers 202 with its job; wait() follows its events to the result:
const run = await tools.run('png', {}, { files: [{ name: 'photo.jpg', data: bytes, type: 'image/jpeg' }] });
run.state;                                                     // 'queued' (run.job, run.location = /api/v1/jobs/job_…)
const done = await run.wait({ onEvent: (e) => show(e.job.progress) });
done.result.files[0];                                          // { name: 'photo.png', mime, size, sha256, url, … }
const bytesOut = await (await tools.jobs.file(done.job.id, 0)).arrayBuffer();

// One tool's output feeds the next, without a download:
const webp = await (await tools.run('webp', {}, { files: [{ job_id: done.job.id, index: 0 }], waitMs: 10000 })).wait();

try {
    await tools.run('jsonminify', { text: '{' });
} catch (err) {
    if (isToolRunError(err)) console.log(err.code, err.status, err.detail);   // the tool's own problem+json
}
```

- **What `run()` resolves to.** An inline tool, or a job that finished within `waitMs`, gives `{ state: 'succeeded', tool, result, took_ms, job?, location? }`. `result` carries `data` (output kind json), `text` (kind text) or `files` (kind file or files: the job's result files). A job still queued or running gives `{ state: 'queued' | 'running', tool, job, location }`. Both have `idempotencyKey`, `replayed` and a non-enumerable `wait(opts)`. On a finished run `wait()` resolves to the run itself, so `await (await tools.run(…)).wait()` works for every tool. On a job, `wait()` takes `jobs.wait`'s options (`signal`, `onEvent`, `lastEventId`), and `tools.jobs.wait(job.id)` gives the raw job.
- **Failures.** A run that finished `failed` or `cancelled` throws `ToolRunError`. It is an `OpenVibeError` with the tool's problem+json mapped: `code`, `status` (the problem's, e.g. 422 or 504, not the HTTP 200), `detail` and `errors`. It also carries `state`, `tool`, `job` and `run`. When `err.retryable`, `tools.jobs.retry(err.job.id)` runs the failed job again. A refusal before the tool ran is a plain `OpenVibeError`: 404 `tools.tool.not_found` or `tools.tool.not_runnable` (`api: false`: the YouTube downloader is page-only and never in the SDK), 422 `tools.input.invalid` (with `errors[]` pointers), 401 `token.*`, 403 `capability.denied`, 413/415 for files, 429 `quota.exceeded` or `tools.job.too_many_active`, 503 `tools.tool.unavailable`.
- **Idempotency and retries.** Every run carries an `Idempotency-Key`, generated when you pass none and returned as `idempotencyKey`. The same key and request give the same job (`replayed: true`); a different request under that key is 409 `tools.job.idempotency_conflict`. Inline tools ignore the key. Because of the key, the client retries a 429 after its `Retry-After` (capped by `maxRetryDelayMs`) and retries 5xx and timeouts without creating a second job. To survive a crash between the run and saving the job id, derive the key from the request and run again with it.
- **Files.** Uploads use the jobs client's shapes: a `Blob`/`File`, or `{ name, data: Buffer | Uint8Array | ArrayBuffer | Blob | string, type? }`. They go as multipart `file` parts. References are `{ media_id: 'med_…' }` (a Media object you may read) and `{ job_id: 'job_…', index }` (a result file of your own job). They go in the JSON body's `files`, or, beside uploads, as a multipart `files` part holding their JSON. The tool gets the uploads first, then the references in order, and the count must fit the descriptor's `files.min`/`files.max`.
- **Waiting and timeouts.** `waitMs` (0 to 60000) lets a job tool answer finished when it is quick. Each attempt's timeout is raised to `waitMs`, or to the tool's `limits.timeoutMs` once this client has read its descriptor (`get` or `list`), plus 10 s. Pass `timeoutMs` to set it yourself. `signal` aborts the run (`sdk.aborted`), and a `wait()` too. Aborting a wait leaves the job running.
- **Who may run what.** Callers are tiered anonymous < session < user < app/service. Without a token you run the tools whose descriptor says `auth.anonymous: true`, keyed by IP. A person's token runs every tool except network probes. An app or service token (audience `openvibe.tools`) needs the descriptor's `auth.capability`: `tools.tool.run` (public), or `tools.net.probe` (partner: staff grant it by hand). Quotas count each tool's `cost` within its `quotaClass`. Registry reads (`tools.tool.read`) are public and send no token unless you pass `anonymousReads: false`.
- **Jobs.** `tools.jobs` is `createJobsClient()` on the same origin and credentials: the gateway's `/api/v1/jobs` facade, which fronts every satellite. It adds `retry(id)`, which returns `{ job, replayed }` (a failed job as a new one, `retry_of`; asking again returns the same retry), and `reference(id, 'community:paste:p_123')` / `unreference(id, ref)`, which keep a succeeded result while something points at it (`expires_at: null`). Until the facade is deployed (Tools S6), use `createJobsClient(client, { baseUrl: 'https://img.openvibe.tools' })` (or `audio.`, `docs.`) for jobs.

### Testing your app

```js
const { createMockPlatform } = require('openvibe-sdk/testing');
const platform = createMockPlatform({
    clients: { 'my-service': { secret: 's', grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: ['my-app'] }] } },
    apps: { 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR': { env: 'production', type: 'confidential', secret: 's', redirectUris: ['http://localhost:3009/callback'], grants: ['media.object.upload'] } },
    mediaApps: { 'my-app': {} },
    users: [{ username: 'ana' }],
    jobs: true,
    tools: true,
});
const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR', clientSecret: 's', fetch: platform.fetch }) });
```

The mock answers at the real public origins with real RS256 tokens and checks audience, capability, namespace and sandbox the way the services do. It covers:

- **Network:** discovery, `/oauth/token` (client credentials, authorization code with PKCE, refresh; developer apps), `GET /oauth/authorize` (consents automatically as `setAuthorization({ subjectId })`, or declines with `{ decision: 'deny' }`), the JWKS, the registry, `/api/v1/projects` (projects, members, apps, credentials, grants, quotas, audit), `/api/modules` and `/internal/modules`, and `/internal/identity`.
- **Developer apps:** `apps` / `projects` options, `addApp()`, `signAppToken()`. App tokens carry `sub app:…`, `cap`, `ns: [project_id]`, `project_id`, `env` and `on_behalf_of` (code flow); codes are single use, PKCE-bound and bound to the `audience` given at authorize; a sandbox app of a project with members can be authorized only by them. The capability catalog is the public + active capabilities of openvibe-contracts v0.28.0 (`DEFAULT_APP_CATALOG`, `events.app.*` included).
- **Sandbox:** as in production, Media (on `/api/v1/<project_id>/files`) and Events (on the `events.app.*` routes) accept sandbox app tokens and keep their data apart from production; every other route and mock service refuses `env: sandbox` tokens (`401 token.sandbox_refused`) unless `acceptSandbox` lists the audience or capability. Unlike Network, sandbox apps get tokens for any audience unless you pass `sandboxAudiences`, and projects created through the API start with the whole catalog as allowance unless you pass `defaultAllowance: []`.
- **Events:** publish with `event_id` dedupe, pull (with a `gap` after `pruneEvents(seq)`), checkpoints, subscriptions, `/realtime/stream` SSE with `Last-Event-ID` and gap events, and a delivery worker: `deliverEvents()` / `startDeliveries()` POST signed deliveries (v1 and v2 headers, fresh timestamp per attempt) to your local endpoint in order, retry, and mark them dead after `max_attempts`. Developer apps follow OpenVibe.Events' rules: app tokens are judged only on `events.app.publish | read | subscribe`; types `app.<project_key>.<name…>`, source `app-<ulid>`, actor the app or its `on_behalf_of` user; reads, checkpoints and subscriptions limited to the own project in the token's env plus public first-party events (every pattern starts with a literal segment, `app.*` patterns name the own key); app endpoints https and not loopback, private or local names; first-party readers never see sandbox events and see app events only through `app.*`; realtime streams neither. Not modelled: per-project quotas, revocation, and the DNS half of the endpoint check. Your delivery worker's `fetch` (`deliverEvents({ fetch })`) can route `https://hooks.example.com/…` to a local server.
- **Media:** the files API and `GET /f/:key`, with Media's tenant rules: `media.object.upload` uploads and deletes, `media.object.read` lists and gets (app keys, service tokens and app tokens alike); a developer app reaches only `/api/v1/<its project_id>/files`, where production uses the tenant `prj_…` and sandbox `prj_…-sandbox` (100 MB, `mediaQuotaMb`); sandbox files come back as `{ sandbox: true, url: <signed>, url_expires_at }` and `/f/<key>` serves them only with a valid signature.
- **Tools jobs** (`jobs: true | { stepMs, handlers }`) at `origins.tools` and the satellites `img.`, `audio.` and `docs.openvibe.tools` (`platform.toolsOrigins`; `toolsSatellites` overrides). Each satellite keeps its own jobs, and `origins.tools` is the gateway facade that also finds theirs. Covered: submit with Idempotency-Key replay, get, cancel, retry, references, SSE with `Last-Event-ID` and `204` when finished, and result files. Every view is `tools.job@1`, with `error` as problem+json. `dropJobStreams()` simulates a dropped connection.
- **Tools platform API** (`tools: true | { descriptors, handlers, mediaObjects, stepMs }`) on `origins.tools`: `GET /api/v1/tools[/:id[/schema]]` and `POST /api/v1/tools/:id/run`, answering as openvibe-contracts v0.33.0 says. The default tools are `dns` (sync), `jsonminify` (a client tool with a server engine), `png` (a job), `port` (a probe needing `tools.net.probe`), `yt` (page-only) and `protectpdf` (unavailable). `descriptors` adds or replaces tools, and `handlers` answers them (`{ data }` or `{ text }` inline, a job handler for job tools). Also: `addTool()`, `addMediaObject()` (what `{ media_id }` reads) and `state.tools`. The mock checks caller tiers, the refusal codes, the file count and type, and the input's top-level fields. Idempotent job runs, `wait_ms` and file references work. It has no browser sessions, so job tools need a token. It has no quotas either: to test a 429, wrap `platform.fetch`.

Helpers: `signUserToken()`, `signServiceToken()`, `signAppToken()`, `authorize()`, `setAuthorization()`, `publishEvent(envelope, publisher, { projectId, env })` (a registered app's `app:<id>` publisher implies them), `pruneEvents()`, `deliverEvents()`, `dropRealtime()`, `dropJobStreams()`, `addTool()`, `addMediaObject()`, and `stats` and `state` for assertions. Its `fetch` rejects on an aborted signal, as `fetch` does. It is a fake. It has no persistence, its visibility rules are simplified, and it has no Chat (no WebSocket mock).

### Browser without a bundler

```html
<script type="module">
  import { createClient, auth, registry } from '/vendor/openvibe-sdk.mjs';   // copied or served from node_modules/openvibe-sdk/browser/
  const { url, state, codeVerifier } = await auth.startAuthorization({ clientId, redirectUri, audience: 'openvibe.media', scope: ['media.object.read'] });
</script>
```

`browser/openvibe-sdk.mjs` is generated by `node scripts/browser-bundle.js` from the CommonJS sources reachable from `browser.js` (no dependencies, no transpiling) and checked in. It exports core at the top level and `auth` (browser build), `registry`, `modules`, `realtime`, `media`, `community`, `jobs`, `tools` and `projects` as namespaces. `test/bundle.test.js` fails when it is stale, and the browser secret scan covers it.

## Versioning

- `openvibe-sdk` follows semver. While it is 0.x, a minor release may break an API, and [CHANGELOG.md](CHANGELOG.md) says so. Pin a tag.
- Each release states the openvibe-contracts range it was tested against (`CONTRACTS_RANGE`), and `discover()` checks it at runtime. Contract types are copied into `types/contracts.d.ts`. `test/types.test.js` fails if they differ from the pinned Contracts release, the `openvibe-contracts` devDependency (a release tarball pin, v0.33.0), which the tools tests also use to validate requests and answers. It is never a runtime or peer dependency.
- A new public capability ships as a minor release: first the contract, then the wrapper here, then the service's route. Removing a wrapper is a major release, after the capability's deprecation window in Contracts has passed.

## Not wrapped yet (intentionally)

- **Community comments on other content, the forum and Pulse** are being built in Community right now. Only paste comments are wrapped. The rest is a TODO in `src/community.js` until those APIs settle.
- **Media:** the v1 files API, the object API v2 (`createObjectsClient`) and the public URL helpers are wrapped. Retention holds on v2 objects are not (app keys only). VOD, clip, thumbnail and admin-storage routes are not wrapped because apps reach them only through Live and Media's own servers. Media's own paste API is not wrapped because pastes moved to Community (ADR-011). The mock platform (`openvibe-sdk/testing`) models Media's v1 files only, not v2 objects.
- **Media from the browser:** Media refuses user JWTs on `/api/v1/:app/files`, so a browser uploads through its own app server. That server holds the app key and names the user with `actingUserId`.
- **Network coins, notifications and legacy-map writes** are internal service-to-service routes with no public capability, so they are not wrapped. Staff-only paste routes are also internal: admin stats, bulk, censor and the AI pass.
- **Chat, Live, Billing and Games** from the original charter come when those services publish their capabilities in Contracts. Chat has no app principal (`chat.message.send` is `first-party`), so there is no Chat client and no Chat mock.
- **Tools** are not wrapped one by one: `openvibe-sdk/tools` runs any tool with `api: true` by id, and its descriptor (`tools.get(id)`) gives the input schema, files and limits. `openvibe-sdk/jobs` still submits any job `type` directly. The YouTube downloader is page-only (`api: false`), so it is not in the SDK.
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
