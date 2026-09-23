# OpenVibe.SDK

> Supported browser and server clients for the OpenVibe platform.

**Status:** alpha, v0.1.0 (roadmap Wave 2). Runs and is tested against local stub servers and the built-in mock platform. No OpenVibe service or app uses it in production yet.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §3.2; roadmap §30.  
**License:** MIT ([LICENSE](LICENSE)). This package is a library that apps outside the network embed, so it uses MIT. The OpenVibe services themselves stay AGPL-3.0.

**If a capability is not in the SDK, it is not public.** Apps call services through `openvibe-sdk` and never build internal routes themselves. A route with no SDK wrapper is internal, even when you can reach it, and it can change without notice. To make a capability public, first define it in OpenVibe.Contracts, then wrap it here.

```bash
npm install https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.1.0
```

It has no runtime dependencies. It needs Node ≥ 20, or any browser with `fetch`, Web Crypto and `TextDecoder`. There is no build step. The package is CommonJS with ESM entry points (`import` works). Each subpath has its own `.d.ts`. `openvibe-contracts` is an optional peer dependency pinned to v0.6.0. The SDK doesn't need it at runtime and copies the contract types it uses.

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

**The token exchange happens on your server.** Every OpenVibe OAuth client is confidential: it has a client secret, and a secret must never reach a browser. The browser entry points contain no exchange code. A test scans every file a browser bundle can reach and fails on `client_secret`, `node:` imports, `require('crypto')` or `process.env`.

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

### External developer (an app outside the network)

An app with only a client id, a secret and a capability grant (for example `media.object.upload` for its own namespace) authenticates, finds Media through the registry and uploads a file:

```js
const sdk = require('openvibe-sdk');

const client = sdk.createClient({
    tokenProvider: sdk.auth.createServiceTokenClient({ clientId: 'my-app', clientSecret: process.env.OV_CLIENT_SECRET }),
});
await client.discover();                                   // origins + contracts version from https://openvibe.network/.well-known/openvibe
const media = sdk.media.createMediaClient(client, { app: 'my-app' });
const file = await media.upload(fs.readFileSync('logo.png'), { filename: 'logo.png', contentType: 'image/png' });
file.public_url;   // https://openvibe.media/f/<key>
```

`test/testing.test.js` runs this flow end to end against `openvibe-sdk/testing`.

## API

| Subpath | Where | What |
|---|---|---|
| `openvibe-sdk/core` | both | `createClient()`, `OpenVibeError`, `paginate()`, `offsetPager()`, trace and id helpers, `CONTRACTS_RANGE` |
| `openvibe-sdk/auth` | server (browser build: PKCE only) | `createServiceTokenClient()`, `verifyUserToken()`, `exchangeCode()`, `refreshUserToken()`; `startAuthorization()`, `buildAuthorizeUrl()`, `createPkcePair()`, `pkceChallenge()`, `readCallback()` |
| `openvibe-sdk/registry` | both | `createRegistryClient(client)`: `services({status})`, `service(id)`, `capabilities({owner})`, `capability(id)`, `namespaces()`, `contracts()`, `topics()`, `domain(host)`, `descriptor()` |
| `openvibe-sdk/identity` | server | `createIdentityClient(client)`: `resolve({subjectId} \| {system,type,id})`, `resolveBatch({subjectIds} \| {system,type,ids})` |
| `openvibe-sdk/modules` | both | `createModulesClient(client)`: `get`, `put(ns, data, {revision})`, `delete`, `list`, `update(ns, fn)`, `publicGet`; `forSubject.get/put/update` for services |
| `openvibe-sdk/events` | server | `createEventsClient(client, {source})`: `publish`, `prepare`, `pull`, `iterate`, `get`, `get/setCheckpoint`, `subscriptions.create/list/get/disable/enable` (`subscribe`), `deliveries`, `replay`; `verifyDelivery`, `signDelivery`, `parseDelivery` |
| `openvibe-sdk/realtime` | both | `subscribe(topics, onEvent, {lastEventId, onGap, …})`, `createRealtimeClient(client)` |
| `openvibe-sdk/media` | both (credentials: server) | `createMediaClient(client, {app, apiKey?, actingUserId?})`: `files.upload/list/iterate/get/delete`; `mediaUrls(origin)` public URL helpers |
| `openvibe-sdk/community` | both | `createCommunityClient(client, {actingSubject?, origin?, sourceRef?, staff?})`: `pastes.list/iterate/get/create/update/delete/fork/like/copy/versions/byUser/config`, `pastes.comments.list/create/delete`, `as(subject)` |
| `openvibe-sdk/testing` | Node | `createMockPlatform()`: fake Network, Events and Media on an in-process `fetch` |

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
- **Pagination.** `paginate(fetchPage, { cursor })` is an async iterator over `{ items, next }` pages. The `iterate()` methods build on it: Events uses `after_seq`, and Media and Community use offsets.

### Auth details

- `createServiceTokenClient()` follows the rules of openvibe-contracts `serviceAuth.createTokenClient()` but needs no dependencies. It sends `POST /oauth/token` with `grant_type=client_credentials`, `audience` and an optional `scope`, which can be a string, an array, or a map from audience to scope. It keeps one cached token per audience until 60 s before expiry and shares one in-flight request. As a `tokenProvider`, each call gets a token for the audience of the service it calls: `openvibe.<service>` by default, or the value in `audiences` if you set one.
- `verifyUserToken(token, { jwks, issuer, audience })` checks a token offline:
  - It accepts RS256 only. `alg: none`, HS256 and anything else fail as `token.malformed` before any key is used.
  - It checks the signature against the JWKS document or URL. A URL is cached for 6 h and fetched again when a token carries an unknown `kid`. It also accepts the Network's legacy `public_key` field or a PEM string.
  - It checks `exp`, `nbf` and `iat` (30 s clock skew), then `iss` and `aud`.
  - It rejects service-principal tokens (`token.not_user`).

  It returns the claims, including `subject_id`.
- PKCE follows RFC 7636 S256. The verifier is 64 characters from the unreserved set, and the challenge is `BASE64URL(SHA-256(verifier))`. See the gaps below for what the Network does with it today.

### Testing your app

```js
const { createMockPlatform } = require('openvibe-sdk/testing');
const platform = createMockPlatform({
    clients: { 'my-app': { secret: 's', grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: ['my-app'] }] } },
    mediaApps: { 'my-app': {} },
    users: [{ username: 'ana' }],
});
const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'my-app', clientSecret: 's', fetch: platform.fetch }) });
```

The mock answers at the real public origins with real RS256 tokens and checks audience, capability and namespace. It covers:

- **Network:** discovery, `/oauth/token` (client credentials, authorization code with PKCE, refresh), the JWKS, the registry, `/api/modules` and `/internal/modules`, and `/internal/identity`.
- **Events:** publish with `event_id` dedupe, pull, checkpoints, subscriptions, and `/realtime/stream` SSE with `Last-Event-ID`.
- **Media:** the files API.

Helpers: `signUserToken()`, `authorize()`, `publishEvent()`, `dropRealtime()`, and `stats` and `state` for assertions. It is a fake. It has no persistence and no delivery worker, and its visibility rules are simplified.

## Versioning

- `openvibe-sdk` follows semver. While it is 0.x, a minor release may break an API, and [CHANGELOG.md](CHANGELOG.md) says so. Pin a tag.
- Each release states the openvibe-contracts range it was tested against (`CONTRACTS_RANGE`), and `discover()` checks it at runtime. Contract types are copied into `types/contracts.d.ts`. `test/types.test.js` fails if they differ from the pinned Contracts release. CI clones `OpenVibe.Contracts` at the pinned tag for this check.
- A new public capability ships as a minor release: first the contract, then the wrapper here, then the service's route. Removing a wrapper is a major release, after the capability's deprecation window in Contracts has passed.

## Not wrapped yet (intentionally)

- **Community comments on other content, the forum and Pulse** are being built in Community right now. Only paste comments are wrapped. The rest is a TODO in `src/community.js` until those APIs settle.
- **Media v2 objects** (`med_` ids, ADR-006) are being added to Media right now. This release wraps only the v1 files API that exists on Media's `main`, plus the public URL helpers. VOD, clip, thumbnail and admin-storage routes are not wrapped because apps reach them only through Live and Media's own servers. Media's own paste API is not wrapped because pastes moved to Community (ADR-011).
- **Media from the browser:** Media refuses user JWTs on `/api/v1/:app/files`, so a browser uploads through its own app server. That server holds the app key and names the user with `actingUserId`.
- **PKCE enforcement:** the SDK sends `code_challenge` and `code_verifier`, but the Network's `/oauth/authorize` and `/oauth/token` don't verify them yet. The mock platform does. Security today rests on the client secret, which never leaves the server.
- **Network coins, notifications and legacy-map writes** are internal service-to-service routes with no public capability, so they are not wrapped. Staff-only paste routes are also internal: admin stats, bulk, censor and the AI pass.
- **Chat, Live, Billing, Games and Jobs** from the original charter come when those services publish their capabilities in Contracts.
- **Realtime over WebSocket and presence** don't exist in Events yet (ADR-005). SSE is the only transport.

## Development

```bash
npm test                                 # every test/*.test.js: stub servers + mock platform, then npm pack + install
fnm exec --using=22.22.1 npm test        # the Node version production runs
node scripts/esm.js                      # regenerate esm/*.mjs after changing a module's exports
```

Style: CommonJS, 4-space indent, single quotes, semicolons. Browser-safe files use only `fetch`, `Headers`, `FormData`, `Blob`, `URL`, `TextEncoder`/`TextDecoder` and `globalThis.crypto` (Web Crypto). Server-only files may use `node:` modules and are marked `"browser": null` in `package.json`.

## Owns / does not own

Owns the supported client surface, version negotiation and feature detection, and the mock adapters for development. It doesn't own service implementations, and it doesn't own UI components (OpenVibe.Shared). It replaces the hand-written per-repo clients: Live's `media-client`, Community's proxies and Tools' fetch helpers.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
