# Adopting `openvibe-sdk/service`

`openvibe-sdk/service` replaces the code each service wrote around the shared pieces: the graceful stop (three shapes in
about 17 files, `server/graceful.js` copied into OpenVibe.Network and OpenVibe.Community) and the error wrappers around
the problem body (`ApiError`/`TipsError`/`VipError`…, `run`, `wrap`, `sendError`, `jsonBody`, `privateNoStore`, the
terminal error middleware). The plan T1 audit (`sdk-plan-t1-the-service-kit-audit`) is the inventory this recipe follows.

Readiness, metrics, `/release.json` and the problem body are already shared in every service (`openvibe-shared/ready`,
`/metrics`, `/release`; `openvibe-contracts` `http.problem`/`sendProblem`). The kit re-exports them under the same names
and never copies them: each is required from the service's own `node_modules` on first use, so the SDK gains no
dependency, and a service that lacks the package gets an error naming it (`code: 'sdk.missing_dependency'`). Switching
`require('openvibe-shared/ready')` to `require('openvibe-sdk/service')` is optional and changes nothing.

Convert one service at a time, smallest first (the audit's order): Blog, Codes, News, Deals, Coupons, VIP, Tips, Trade
(errors only), Wiki, Reviews, Network, Community, Billing, Bot, Chat, Host, AI, Events, Search, Sources, Media,
OpenRestream, Live.

## The stop

```js
const { gracefulStop, within } = require('openvibe-sdk/service');
const lifecycle = gracefulStop({
    name: 'Blog',                 // log prefix
    server,                       // the http.Server (leave it out for a worker)
    stop: [],                     // first, in order: nothing new starts (timers, pollers, relays)
    beforeDrain: undefined,       // (signal) => …, after the stop steps, while the server still takes connections
    close: [],                    // after the HTTP drain, in order (outbox, analytics, database)
    handles: undefined,           // closed last (close(), else stop()/end()/quit(), or a function); a failure exits 1
    drainMs: 4000,                // requests in flight may take this long, then they are cut
    deadlineMs: 5000,             // the whole stop
    deadlineExitCode: 1,          // past the deadline
    signals: true,                // SIGTERM and SIGINT (false in tests)
    exit: process.exit,           // injected in tests
    log: console,
});
// lifecycle.stop(signal?) → Promise<exit code>; lifecycle.stopping() → true from the first signal on
```

What it does, in order: `stopping()` turns true; the stop steps; `beforeDrain`; `server.close()`, `Connection: close`
on every response still in flight, idle keep-alive connections closed at once and every 50 ms after, open
`text/event-stream` responses destroyed (EventSource reconnects to another process); after `drainMs` whatever is open
is cut; the close steps; the handles; `exit(0)` (1 when a handle failed). A step that throws is logged and the stop goes
on. `exit` is called exactly once: by the end of the stop, or by the deadline with `deadlineExitCode`. A second signal
returns the first stop's promise.

Two things differ from the copies in Network and Community: the deadline timer is not `unref()`'d (a step stuck on a
promise with nothing else alive used to let the process exit 0 on its own; now the deadline decides), and `stop()`
resolves with the exit code it passed to `exit`.

`within(ms, promise)` is the best-effort step: it waits for the promise but no longer than `ms`, and swallows a
rejection. Use it where a step may hang or fail and the stop must go on regardless: `stop: [() => within(3000,
mirror.flush())]`.

**Readiness during the stop.** `stopping()` turns true before any step runs. A check makes `/api/ready` answer 503 for
the whole stop:

```js
let lifecycle = null;
const readiness = createReadiness({ service: 'live', release, checks: [
    { name: 'accepting', required: true, check: () => !(lifecycle && lifecycle.stopping()) || 'stopping' },
    // …the service's own checks
] });
// …after listen:
lifecycle = gracefulStop({ name: 'Live', server, /* … */ });
```

### The 5 s family: Blog, Codes, Coupons, Deals, News, Trade, VIP, Host, Billing, Chat, Bot, Tips

Today: `server.close(cb)` → close the store → `process.exit(0)`, and a 5 s timer that also exits **0**. Keep the exit
code with `deadlineExitCode: 0`:

```js
gracefulStop({
    name: 'Blog', server, deadlineExitCode: 0,                     // drainMs 4000, deadlineMs 5000 (the defaults)
    stop: [() => worker.stop(), () => changelog.stop()],
    close: [() => ctx.outbox.stop(), () => ctx.store.close()],
});
```

- VIP closes `domain.db`; Billing adds `() => valkey.close()` before `db.close()`; Bot moves its sequence into `stop`
  (clear timers, `keys.stop()`, `hub.close()`, `outbox.stop()`) and `close` (`db.close()`, Valkey); Tips likewise.
- Chat's pre-drain flush: `stop: [() => within(3000, mirror.flush())]`, `close: [() => db.close()]`.
- Host raises `server.requestTimeout` to 10 minutes for uploads; a 4 s drain cuts an upload in progress, as today's 5 s
  timer does. Keep that, or give Host a `drainMs`/`deadlineMs` that matches the upload policy and the manifest's
  `lifecycle.shutdown`.
- Trade: the stop converts as above. Its `/release.json` and `/api/ready` are XState machine states and stay as they are.
- New behaviour for this family (all of it safer): requests in flight are told `Connection: close`, idle keep-alive
  connections no longer hold the stop open until the timer, event streams are ended.

### Network and Community

Delete `server/graceful.js` and import from the kit; the options are the same names.

```js
const { gracefulStop, within } = require('openvibe-sdk/service');
gracefulStop({ name: 'Network', server, stop, close, drainMs: 8000, deadlineMs: 10000 });   // exit 1 past the deadline
gracefulStop({ name: 'Community', server, stop, close });                                    // 4000 / 5000, exit 1
```

Their tests that inject `exit` and pass `signals: false` keep working; `stop()` now resolves with the exit code instead
of always 0.

### The handles family: AI, Events, Search (10 s), Sources (20 s)

Today: `server.closeAllConnections?.()`, `server.close`, `handles.close().then(exit 0, exit 1)`, a hard timer that exits
**1**. The `handles` option is that last step:

```js
gracefulStop({ name: 'AI', server, handles, drainMs: 8000, deadlineMs: 10000 });             // handles.close(): a rejection exits 1
gracefulStop({ name: 'Sources', server, handles, drainMs: 15000, deadlineMs: 20000 });
```

Behaviour change: these services cut every connection first today; with the kit, requests in flight get `drainMs` to
finish. Pick `drainMs` below the deadline.

**Reviews and Wiki** (10 s, exit **0**, `h.stop().finally(exit 0)`): a failed `h.stop()` still exits 0 there, so make
it a close step, not a handle:

```js
gracefulStop({ name: 'Reviews', server, close: [() => h.stop()], drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 0 });
```

### Media: 70 s for the ffmpeg trailers

Today: nine best-effort stops, `server.close`, then up to 70 s for ffmpeg to write the recordings' trailers; the timer
exits **0**.

```js
gracefulStop({
    name: 'Media', server, deadlineMs: 70000, deadlineExitCode: 0,
    stop: [/* the health, verify and owner-subject jobs, the worker, the JWKS refresh, the events reset */],
    beforeDrain: () => recorder.stopAll(),                        // ffmpeg starts writing trailers now
    close: [() => recorder.settled(), () => vod.stop(), () => valkey.close()],   // the recorder's wait: no `within` (the deadline bounds it)
});
```

(`recorder.stopAll()`/`recorder.settled()` stand for Media's own calls.)

### Live: last, it needs `beforeDrain` and the readiness flip

Live flips `_bootComplete = false` before anything else so `/api/ready` answers 503 while it still serves, stops the
chat/RTMP/FFmpeg children and restreamers, ends its SSE streams deliberately (`closeAll()`, then 300 ms), closes every
SFU and relay, then `server.close`, with a 5 s timer that exits **1**.

```js
lifecycle = gracefulStop({
    name: 'Live', server,                                          // deadlineMs 5000, exit 1 (the defaults)
    stop: [() => within(1500, children.stopAll()), () => restreamers.stopAll()],
    beforeDrain: async () => { sse.closeAll(); await new Promise((r) => setTimeout(r, 300)); },
    close: [() => sfus.closeAll(), () => relays.closeAll()],
});
```

with the `accepting` readiness check above replacing `_bootComplete = false`. The drill branch (3 s) stays outside the
kit.

### OpenRestream

It has no hard timer today. `gracefulStop({ name: 'OpenRestream', server, close: [...] })` adds one (5 s, exit 1): new
behaviour, but a safer one.

## The telemetry

The kit carries the HTTP telemetry Network wrote in `server/telemetry.js` and `server/observability.js`, so every
service emits `platform.telemetry-sample@1` the same way. A request is not a row: requests are aggregated per
`route|method|status_class` per flush interval into `count`, `sum`, `max` and `p95`, and **one** `http.request`
sample per key is emitted per flush — plus the HTTP autoscaling gauges (active requests, rolling p95, event-loop
lag) once per flush from a timer, never per request. The SDK buffer (maxBuffered 1000) therefore cannot overflow.
A sample carries the route template, method and status class — never a raw URL, client id or token (a request
that matched no route is `unmatched`, and the per-flush key map and latency samples are capped, so a scanner or a
404 flood stays bounded).

```js
const svc = require('openvibe-sdk/service');
const collector = svc.createHttpTelemetry({
    service: 'blog',                                     // the schema's service; there is no `instance` field
    sink: (samples) => post('/internal/telemetry', samples),   // one batch per flush
    intervalMs: 15000,                                   // also the p95 window
    skipPrefixes: ['/shared'],                           // default ['/shared']; Network passes '/shared', '/api/chrome'
    routeLabel: (req) => metrics.routeLabel(req),        // optional; default reads req.route.path under req.baseUrl
});
app.use(collector.middleware());                         // per request, before the routes
svc.gracefulStop({ name: 'Blog', server, stop: [() => collector.stop()] });   // stop() emits once, then flushes once
```

The process-wide singleton keeps Network's shape, for a service that just wants it wired at boot:

```js
svc.telemetry.init({ service: 'blog', sink });           // starts the flush timer and the event-loop monitor
app.use(svc.telemetryMiddleware);                        // a no-op until init, so mount order is not delicate
svc.gracefulStop({ name: 'Blog', server, stop: [() => svc.telemetry.stop()] });   // stops both, flushes once
```

`telemetrySkipped(req)` skips `/api/health`, `/ready`, `/api/ready`, `/metrics` and static assets by extension;
`skipExact`, `skipPrefixes` and `skip(req)` add a service's own probes, chrome and shared assets. Field mapping
(`platform.telemetry-sample@1` has no generic gauge field): an aggregated request carries its mean in `latency_ms`
and the counts in `extra`; the p95 gauge carries its value in `latency_ms` (it is a latency); the active-requests
and event-loop-lag gauges carry theirs in `extra`, never in `latency_ms` (which a consumer reads as a response
time). `registerSignals({ start, stop, lag })` injects a service's own monitor in place of the default.

**Network and Community** delete `server/telemetry.js` and the telemetry block of `server/observability.js`
(`telemetrySkipped`/`telemetryMiddleware`/the loop monitor) and register the kit's middleware with
`skipPrefixes: ['/shared', '/api/chrome']`; their `analyticsSink` becomes the `sink` passed to `init`.

## The errors

```js
const svc = require('openvibe-sdk/service');
const ApiError = svc.createServiceError('ApiError');   // (status, code, detail?, extra?) → .status .code .detail .extra
```

Every helper takes the same options: `{ name = 'service', log = console, extra = 'spread', internalCode =
'internal.error', internalDetail = 'Internal error', publishing = false, map, noStore = false }`. The defaults are
Reviews/Wiki `sendError`:

| | |
|---|---|
| status | the error's (400–599), else 500 |
| logged | 5xx except 503 |
| code | the error's, else `internal.error` at 500 and `request.invalid` otherwise (an unexpected error's own code, such as a PostgreSQL `23505`, never reaches the body) |
| detail | `'Internal error'` at 500, else the error's detail or message |
| extra | spread into the body; `extra: 'details'` nests it as `{ details }`, below 500 only (Tips/VIP) |

An error is a service's own refusal when it comes from `createServiceError`, when `map(err)` returns one, when
`publishing` maps it (an `openvibe-publishing` `PublishingError`, with `revision.conflict`'s `expected`/`current`, and a
`TypeError` that is not a bug, as 422 `request.invalid`), or when it has an HTTP status and a string code (any other
service's error class).

| family | today | with the kit |
|---|---|---|
| Blog, Trade, Deals, News (`server/http/errors.js`) | `ApiError`, `asApiError`, `run`, `jsonBody`, `privateNoStore` | `const o = { name: 'Blog API', publishing: true, ServiceError: ApiError }`; `run: (fn, s) => svc.run(fn, s, o)`, `asApiError: (e) => svc.asServiceError(e, o)`, `jsonBody: svc.jsonBody()`, `privateNoStore: svc.privateNoStore`; keep the module's exports so no call site moves |
| Reviews, Wiki (`server/http/common.js`) | `sendError(res, req, err, log)`, `run(fn, status, log)` (Cache-Control private, no-store) | `svc.sendError(res, req, err, log, { name: 'Reviews' })`, `svc.run(fn, status, { name: 'Reviews', log, noStore: true })` |
| Tips, VIP (`server/util.js`, `api/v1.js`) | `TipsError`, `fail`, `wrap`, `sendError` with `{ details }`, `tips.internal`, `'internal error'` | `const o = { name: 'Tips', extra: 'details', internalCode: 'tips.internal', internalDetail: 'internal error', map: inputError }`; `wrap: (fn) => svc.wrap(fn, o)` |
| Bot (`server/app.js` terminal middleware) | 404 + error mapping for `/api/` and `/internal/`, text/plain for pages | `app.use(svc.jsonErrors({ name: 'Bot', internalCode: 'bot.internal', map: inputError }))`; Bot answers `request.malformed_json` today, the kit `request.invalid_json` (a code change: keep Bot's own middleware until its clients are checked) |

`jsonBody({ limit = '512kb', parser })`: a JSON body parser without Express. Malformed JSON is 400
`request.invalid_json` (`'Malformed JSON body'`); a body over the limit is 413 `request.too_large` (Blog's answered 400
`request.invalid_json` there); an encoding other than gzip/deflate/br is 415. Like `express.json()` it parses
`application/json` and `+json` only, objects and arrays only, an empty body is `{}`, and a body already parsed is left
alone. `parser: express.json({ limit })` keeps Express's parser and maps its errors the same way.

`jsonErrors()` is opt-in: adopting it decides which paths answer JSON and which text, so mount it only where that is
already the behaviour.

## The resource index and the control plane

ADR-048 makes every service that owns resources answer `GET /api/v1/resources` with a
`common.resource-list-result@1` page of `common.resource-summary@1`, and every change a call to
`POST /api/v1/resources/control` with a `common.resource-control-request@1` that it answers with a
`common.resource-control-result@1`. `openvibe-sdk/resources` carries both sides; it is server-only (a
control plane carries a user or service token and is never shipped to a page).

```js
const { createResourceIndex, createResourceClient, resourceName } = require('openvibe-sdk/resources');

// A console reads several authorities and merges their index pages; a failing authority is reported, not fatal.
const index = createResourceIndex({ authorities: ['https://media.openvibe.network', 'https://openvibe.events'], token: userAccessToken });
const { resources, stale } = await index.list({ project: prj.id, kind: 'media.object' });   // follows each next_cursor
const mine = await index.list({ owner: 'usr_…' });   // a person's own resources (no project), filtered by each authority

// A change is a control call to the authority that owns the resource; it decides, we only show the answer.
const media = createResourceClient({ origin: 'https://media.openvibe.network', token: userAccessToken });
const result = await media.control({ action: 'delete', project_id: prj.id,
    resource: resourceName({ service: 'media', project_id: prj.id, type: 'object', id: objectId }),
    idempotency_key: 'idem_…' });                        // done | pending | refused | failed
if (result.state === 'refused' && result.confirmation_required) retryWith(result.confirmation_required.confirmation_id);
```

An authority answers `?project=`, `?kind=` and `?owner=` (a `usr_…` or `agt_…` subject: only what that subject owns,
by the column its summaries take `owner` from) together, and refuses a malformed value with 400 rather than ignoring
it. A console still filters the merged page itself, so an authority that has not added a filter yet never leaks a
row; it only costs a longer walk.

`parseResourceName`, `resourceName` and `resourceNameOf` reuse the pinned openvibe-contracts
`contracts.resources` helpers (required lazily, only by these three), so no service splits an OVRN on
`:`. `RESOURCE_KINDS` names only the kinds whose three-letter id prefix ADR-048 has chosen
(`media.object`/`med`, `watch.watch`/`wch`); `codes.repo`, `events.queue` and `events.subscription` are
unchosen and `act`, `run` and `zon` are only proposed. The control client generates an idempotency key
when the caller omits one and retries a transient failure (network, timeout, 408/425/429/5xx) with the
same key and body, so an authority applies an action at most once.
