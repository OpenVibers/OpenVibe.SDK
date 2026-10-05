'use strict';
/**
 * openvibe-sdk/service: the HTTP telemetry middleware and autoscaling signals — platform.telemetry-sample@1
 * at a service's request boundary. This is OpenVibe.Network's server/telemetry.js and the telemetry half of
 * its server/observability.js, lifted into the kit so every service emits one shape instead of copying it.
 *
 *   const svc = require('openvibe-sdk/service');
 *   const collector = svc.createHttpTelemetry({
 *       service: 'blog',
 *       sink: (samples) => post('/internal/telemetry', samples),   // one batch per flush
 *       skipPrefixes: ['/shared'],                                 // default ['/shared'] (Network adds '/api/chrome')
 *       routeLabel: (req) => metrics.routeLabel(req),              // optional; the default reads req.route.path
 *   });
 *   app.use(collector.middleware());
 *   svc.gracefulStop({ name: 'Blog', server, stop: [() => collector.stop()] });   // one flush at shutdown
 *
 * The process-wide singleton keeps Network's shape, for services that just want it wired at boot:
 * `svc.telemetry.init({ service, sink, … })` starts the flush timer and the event-loop monitor,
 * `svc.telemetryMiddleware` is the per-request middleware, `svc.telemetry.stop()` stops both and flushes
 * once (a gracefulStop stop step), and requiring this module starts nothing.
 *
 * Volume: a request is not a row. HTTP requests are aggregated per `route|method|status_class` per flush
 * interval into count, sum, max and p95, and ONE `http.request` sample per key is emitted per flush — not
 * one per request. The HTTP autoscaling gauges (active requests, p95, event-loop lag) are emitted once per
 * flush from a timer, never per request, so the SDK buffer (maxBuffered 1000) cannot overflow.
 *
 * Field mapping (platform.telemetry-sample@1; `latency_ms` is the schema's latency field, there is no
 * generic gauge field): an aggregated request carries its mean in `latency_ms` and count/sum/max/p95 in
 * `extra`; the p95 gauge carries its value in `latency_ms` (it is a latency); the active-requests and
 * event-loop-lag gauges carry theirs in `extra` — never in `latency_ms`, which a consumer maps to a
 * response time and would make indistinguishable from a latency.
 *
 * A sample carries the route template, method and status class — never a raw URL, client id or token; a
 * request that matched no route is labelled 'unmatched', never by its path. Per flush, the distinct aggregation
 * keys are capped (DEFAULT_MAX_ROUTE_KEYS; overflow folds into the 'other' route label) and each latency array is
 * capped (LATENCY_SAMPLE_CAP, reservoir-sampled for the p95 while count/sum/max stay exact), so a flush's memory
 * is bounded no matter the traffic. Health, readiness, metrics and static/shared assets carry no product signal
 * and are skipped before anything is counted (telemetrySkipped).
 */
const path = require('node:path');
const { createTelemetry, telemetrySample, validateTelemetrySample } = require('../telemetry');

const DEFAULT_INTERVAL_MS = 15000;
/** Distinct route|method|status_class keys kept per flush; further keys fold into the 'other' route label. */
const DEFAULT_MAX_ROUTE_KEYS = 500;
/** Latency samples kept per key (and for the flush p95) by reservoir sampling; count/sum/max stay exact. */
const LATENCY_SAMPLE_CAP = 10000;
/** Path prefixes skipped by default (no product signal); a service overrides them, Network passes more. */
const DEFAULT_SKIP_PREFIXES = ['/shared'];
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const statusClass = (code) => (code ? `${Math.floor(code / 100)}xx` : 'aborted');
const round = (n, digits = 3) => { const f = 10 ** digits; return Math.round(n * f) / f; };

/** p95 (nearest-rank) of an array of ms latencies; null when empty. Computed at most once per flush. */
function percentile95(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * A fixed-capacity uniform sample of an unbounded stream (reservoir sampling): memory is O(cap). The p95 is
 * read from the sample; a bucket's count/sum/max stay exact on the bucket itself.
 */
function createReservoir(cap) {
    const values = [];
    let count = 0;
    return {
        values,
        push(value) {
            count += 1;
            if (values.length < cap) { values.push(value); return; }
            const j = Math.floor(Math.random() * count);
            if (j < cap) values[j] = value;
        },
        get size() { return values.length; },
    };
}

// ── the event-loop monitor (a signal init starts and stop stops; requiring this module starts nothing) ──
let loopMonitor = null;
function startEventLoopMonitor() {
    if (loopMonitor) return;
    try {
        loopMonitor = require('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
        loopMonitor.enable();
    } catch { loopMonitor = null; }
}
function stopEventLoopMonitor() {
    if (!loopMonitor) return;
    try { loopMonitor.disable(); } catch { /* already gone */ }
    loopMonitor = null;
}
/** Whether the monitor is running (a test asserts that requiring the module starts nothing). */
function eventLoopMonitorEnabled() { return loopMonitor != null; }

/** The event-loop lag since the last flush, ms (the mean includes the 20 ms sampling interval: subtracted);
 *  null before the monitor has a sample. The monitor resets per read, so each gauge covers one flush. */
function eventLoopLagMs() {
    if (!loopMonitor || !(loopMonitor.count > 0 || loopMonitor.max > 0)) return null;
    const lag = Math.max(0, loopMonitor.mean / 1e6 - 20);
    loopMonitor.reset();
    return lag;
}

// The signals a collector reads. registerSignals lets a service (or Network's observability.js, during the
// move) inject its own start/stop/lag without this module owning them; the defaults are the monitor above.
const defaultSignals = { start: startEventLoopMonitor, stop: stopEventLoopMonitor, lag: eventLoopLagMs };
let signals = defaultSignals;
function registerSignals(injected) {
    signals = { ...signals, ...(injected || {}) };
}

// ── what not to observe (no product signal) ───────────────────────
const SKIP_EXACT = new Set(['/api/health', '/ready', '/api/ready', '/metrics']);
// Anything express.static serves: public/ files and image/file assets. JSON is deliberately not here
// (routes such as /release.json and /contracts/*.json are product/observability API, not static assets).
const STATIC_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.css', '.map', '.html', '.htm', '.txt', '.xml', '.webmanifest', '.wasm',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.webm', '.ogg', '.pdf',
]);

/**
 * Whether a request carries no product signal: the probe paths (/api/health, /ready, /api/ready, /metrics),
 * a configured prefix (skipPrefixes), a static asset by extension, or whatever a `skip(req)` function also
 * refuses. `req.path` (Express) or the URL without its query is matched, never the raw URL. skipPrefixes
 * defaults to ['/shared']; OpenVibe.Network passes ['/shared', '/api/chrome']. Pass `prefixes: []` to disable.
 */
function telemetrySkipped(req, { exact = SKIP_EXACT, prefixes = DEFAULT_SKIP_PREFIXES, skip } = {}) {
    if (typeof skip === 'function' && skip(req)) return true;
    const raw = req == null ? '' : req.path || String(req.url || '').split('?')[0];
    const p = raw || '';
    if (exact.has(p)) return true;
    if (prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return true;
    return STATIC_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/** The route label without openvibe-shared/metrics: Express's route template (req.route.path under
 *  req.baseUrl), else 'unmatched'. A request with no matched route is never labelled by its raw path, so a
 *  404 or a scanner stays one bounded 'unmatched' key (as OpenVibe.Network's metrics.routeLabel does). */
function defaultRouteLabel(req) {
    if (req && req.route && typeof req.route.path === 'string') return `${req.baseUrl || ''}${req.route.path}`;
    return 'unmatched';
}

/**
 * createHttpTelemetry({ service, sink, intervalMs = 15000, now, log, maxBuffered, routeLabel,
 *                       skipped, skipExact, skipPrefixes = ['/shared'], skip, maxRouteKeys = 500, signals }) -> a collector:
 *   record/gauge/count, flush, stop, requestStarted, requestFinished, observeRequest, bufferStats,
 *   routeLabel(req), skipped(req), middleware(opts) -> (req, res, next)
 * A request began/ended is folded into the interval's aggregation; flush() emits the interval's samples and
 * hands the SDK everything buffered; stop() emits once and lets the SDK clear its timer and flush (idempotent).
 * `service` is the schema's only process identity: it has no `instance` field, so none is emitted.
 */
function createHttpTelemetry(options = {}) {
    const {
        service = null, sink, intervalMs = DEFAULT_INTERVAL_MS, now, log, maxBuffered,
        routeLabel = defaultRouteLabel, skipped = null, skipExact, skipPrefixes = DEFAULT_SKIP_PREFIXES,
        skip, maxRouteKeys = DEFAULT_MAX_ROUTE_KEYS, signals: injected,
    } = options;
    const sdk = createTelemetry({ service, sink, intervalMs, now, log, maxBuffered });
    const sig = injected ? { ...signals, ...injected } : signals;
    const skipFn = typeof skipped === 'function'
        ? skipped
        : (req) => telemetrySkipped(req, { exact: skipExact, prefixes: skipPrefixes, skip });

    let routes = new Map();      // key -> { route, method, status, count, sumMs, maxMs, latencies, codes }
    let allLatencies = createReservoir(LATENCY_SAMPLE_CAP);   // the flush's latencies, for the single p95 gauge
    let active = 0;              // requests in flight right now
    let activeMax = 0;           // the interval's peak, sampled at request start
    let stopped = false;

    /** A request began: track the in-flight peak here, not after the decrement. */
    function requestStarted() {
        active += 1;
        if (active > activeMax) activeMax = active;
    }

    function observeRequest(info = {}) {
        let r = String(info.route == null ? 'unmatched' : info.route).slice(0, 200);
        const m = HTTP_METHODS.has(info.method) ? info.method : 'OTHER';
        const s = statusClass(info.httpStatus);
        const latency = Number.isFinite(info.latencyMs) && info.latencyMs >= 0 ? info.latencyMs : 0;
        let key = `${r}|${m}|${s}`;
        if (!routes.has(key) && routes.size >= maxRouteKeys) {
            r = 'other';                    // the interval's key map is full: fold the new route label, bounded
            key = `other|${m}|${s}`;
        }
        let bucket = routes.get(key);
        if (!bucket) {
            bucket = { route: r, method: m, status: s, count: 0, sumMs: 0, maxMs: 0, latencies: createReservoir(LATENCY_SAMPLE_CAP), codes: new Set() };
            routes.set(key, bucket);
        }
        bucket.count += 1;
        bucket.sumMs += latency;
        if (latency > bucket.maxMs) bucket.maxMs = latency;
        bucket.latencies.push(latency);
        if (Number.isInteger(info.httpStatus) && info.httpStatus > 0) bucket.codes.add(info.httpStatus);
        allLatencies.push(latency);
    }

    /** The live buffer sizes (diagnostics/tests): the aggregation keys and the sampled latencies held per flush. */
    function bufferStats() {
        let maxKeyLatencies = 0;
        for (const b of routes.values()) if (b.latencies.size > maxKeyLatencies) maxKeyLatencies = b.latencies.size;
        return { keys: routes.size, latencies: allLatencies.size, maxKeyLatencies };
    }

    /** A request ended: free the in-flight slot, then fold it into its aggregation key. */
    function requestFinished(info) {
        if (active > 0) active -= 1;
        observeRequest(info);
    }

    /** Push a gauge whose value(s) live in `extra`; the schema has no generic gauge field and latency_ms
     *  is a consumer's response time, so extra is the documented home (never latency_ms). */
    function emitExtraGauge(name, extra) {
        const sample = sdk.record(name, 0, { extra });
        delete sample.latency_ms;
        return sample;
    }

    /** Drain this interval: one http.request sample per route|method|status_class, then the three gauges. */
    function emitSamples() {
        const buckets = [...routes.values()];
        const latencies = allLatencies.values;
        routes = new Map();
        allLatencies = createReservoir(LATENCY_SAMPLE_CAP);
        for (const b of buckets) {
            const mean = b.count ? b.sumMs / b.count : 0;
            const p95 = percentile95(b.latencies.values);
            const extra = {
                method: b.method,
                status_class: b.status,
                count: b.count,
                sum_ms: round(b.sumMs),
                max_ms: round(b.maxMs),
            };
            if (p95 != null) extra.p95_ms = round(p95);
            if (b.codes.size === 1) extra.http_status = b.codes.values().next().value;
            sdk.record('http.request', round(mean), { status: b.status, resource: b.route, extra });
        }
        // The gauges, once per flush (never per request).
        emitExtraGauge('http.active_requests', { last: active, max: activeMax });
        activeMax = active;   // the next interval's peak starts from what is still in flight
        const p95 = percentile95(latencies);
        if (p95 != null) sdk.record('http.latency_p95_ms', round(p95));   // latency_ms: the schema's latency field
        const lag = sig.lag();
        if (lag != null) emitExtraGauge('http.eventloop_lag_ms', { value: round(lag) });
    }

    /** Emit the interval's samples, then hand the SDK everything buffered (a flush is also the tick). */
    function flush() {
        if (stopped) return Promise.resolve();
        emitSamples();
        return sdk.flush();
    }

    /** Emit once, then let the SDK clear its timer and flush (idempotent). */
    async function stop() {
        if (stopped) return;
        stopped = true;
        emitSamples();
        await sdk.stop();
    }

    const collector = {
        record: sdk.record, gauge: sdk.gauge, count: sdk.count,
        flush, stop, requestStarted, requestFinished, observeRequest, bufferStats,
        routeLabel, skipped: skipFn,
        middleware: (o = {}) => createTelemetryMiddleware(collector, { routeLabel, skipped: skipFn, ...o }),
    };
    return collector;
}

/**
 * The Express/Connect middleware for a collector: a skipped request passes through; otherwise the in-flight
 * peak is sampled at start and the finished request (res 'finish', or 'close' for a client that left) is
 * folded by route|method|status_class. Telemetry never breaks a request and next() runs exactly once.
 */
function createTelemetryMiddleware(collector, { routeLabel = defaultRouteLabel, skipped = telemetrySkipped } = {}) {
    return function telemetryMiddleware(req, res, next) {
        if (skipped(req)) return next();
        try {
            collector.requestStarted();
            const t0 = process.hrtime.bigint();
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try {
                    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
                    const httpStatus = res.writableFinished || res.finished ? (res.statusCode || 0) : 0;
                    collector.requestFinished({ route: routeLabel(req), method: req.method, httpStatus, latencyMs });
                } catch { /* telemetry never breaks a request */ }
            };
            res.once('finish', finish);
            res.once('close', finish);
        } catch { /* telemetry never breaks a request */ }
        return next();
    };
}

// ── the process-wide collector (Network's shape: init/stop across the process, nothing at require time) ──
let current = null;
let currentMiddleware = null;
let timer = null;
let activeSignals = signals;

/**
 * init({ service, sink, intervalMs?, routeLabel?, skipPrefixes?, signals?, … createHttpTelemetry options })
 * -> the collector. Starts the event-loop monitor (the injected signals, else the module's) and the flush timer
 * (unref'd). Call once at boot; a second call stops the previous collector first (its interval is emitted and
 * flushed, its timer cleared) and replaces it.
 */
function init(opts = {}) {
    if (timer) { clearInterval(timer); timer = null; }
    const previous = current;
    current = null;
    currentMiddleware = null;
    if (previous) previous.stop();       // flush the replaced collector's interval; its timer is stopped too
    current = createHttpTelemetry(opts);
    currentMiddleware = createTelemetryMiddleware(current, opts);
    activeSignals = opts.signals ? { ...signals, ...opts.signals } : signals;
    activeSignals.start();
    const interval = Number.isFinite(opts.intervalMs) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
    timer = setInterval(() => { current.flush(); }, interval);
    if (timer.unref) timer.unref();
    return current;
}

function record(...args) { return current ? current.record(...args) : undefined; }
function gauge(...args) { return current ? current.gauge(...args) : undefined; }
function count(...args) { return current ? current.count(...args) : undefined; }
function requestStarted() { return current ? current.requestStarted() : undefined; }
function requestFinished(info) { return current ? current.requestFinished(info) : undefined; }
function flush() { return current ? current.flush() : Promise.resolve(); }

/** Stop the flush timer and the event-loop monitor, and flush the collector once (a gracefulStop stop step;
 *  a second stop changes nothing). After it, the record/… functions are no-ops until the next init. */
async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    const c = current;
    current = null;
    currentMiddleware = null;
    if (c) await c.stop();
    activeSignals.stop();
    activeSignals = signals;
}

/** The singleton's middleware: mounted before any route, a no-op until init (Network's ordering). */
function telemetryMiddleware(req, res, next) {
    if (!currentMiddleware) return next();
    return currentMiddleware(req, res, next);
}

const telemetry = { init, record, gauge, count, requestStarted, requestFinished, flush, stop, middleware: telemetryMiddleware };

module.exports = {
    DEFAULT_INTERVAL_MS,
    DEFAULT_MAX_ROUTE_KEYS,
    LATENCY_SAMPLE_CAP,
    DEFAULT_SKIP_PREFIXES,
    HTTP_METHODS,
    telemetrySample,
    validateTelemetrySample,
    telemetrySkipped,
    defaultRouteLabel,
    createHttpTelemetry,
    createTelemetryMiddleware,
    registerSignals,
    startEventLoopMonitor,
    stopEventLoopMonitor,
    eventLoopMonitorEnabled,
    eventLoopLagMs,
    telemetry,
    telemetryMiddleware,
};
