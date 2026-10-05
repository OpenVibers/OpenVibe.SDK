'use strict';
/**
 * openvibe-sdk/service telemetry: the per-request platform.telemetry-sample@1 middleware and the HTTP
 * autoscaling signals (active requests, p95, event-loop lag), lifted from OpenVibe.Network. Requests are
 * aggregated per route|method|status_class per flush; every emitted sample validates; one flush batches;
 * stop() flushes once; the event-loop monitor starts in init and stops in stop.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { run } = require('./helpers');
const svc = require('../src/service');

const quiet = { log() {}, warn() {}, error() {} };
const noSignals = { start() {}, stop() {}, lag() { return null; } };
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the validation assertions skip */ }

/** A collector with a capturing sink, a manual-only interval and the loop monitor replaced. */
function collector(opts = {}) {
    const batches = [];
    const c = svc.createHttpTelemetry({
        service: 'demo', intervalMs: 3600e3, log: quiet, signals: noSignals,
        sink: async (samples) => { batches.push(samples); }, ...opts,
    });
    return { c, batches, samples: () => batches.flat() };
}

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); }).on('error', reject);
    });
}

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

run([
    ['telemetrySkipped avoids probes and static assets, and honours prefixes and a custom skip', async () => {
        const req = (url) => ({ url });
        for (const p of ['/api/health', '/ready', '/api/ready', '/metrics', '/app.js', '/logo.PNG', '/x/y.css?cache=1']) {
            assert.equal(svc.telemetrySkipped(req(p)), true, p);
        }
        assert.equal(svc.telemetrySkipped(req('/api/posts/1?draft=1')), false, 'a product route is observed, query ignored');
        assert.equal(svc.telemetrySkipped(req('/release.json')), false, 'JSON API is not a static asset');
        assert.equal(svc.telemetrySkipped({ path: '/shared/nav.js', url: '/shared/nav.js' }, { prefixes: ['/shared'] }), true);
        assert.equal(svc.telemetrySkipped({ path: '/shared', url: '/shared' }, { prefixes: ['/shared'] }), true, 'the prefix itself');
        assert.equal(svc.telemetrySkipped({ path: '/sharedness', url: '/sharedness' }, { prefixes: ['/shared'] }), false, 'not a path segment');
        assert.equal(svc.telemetrySkipped(req('/api/x'), { skip: (r) => r.url === '/api/x' }), true);
    }],

    ['requests aggregate per route|method|status_class and every sample validates: one flush batches', async () => {
        const { c, batches, samples } = collector({ signals: { start() {}, stop() {}, lag() { return 9.5; } } });
        c.requestStarted();
        c.requestFinished({ route: '/api/posts/:id', method: 'GET', httpStatus: 200, latencyMs: 12 });
        c.requestFinished({ route: '/api/posts/:id', method: 'GET', httpStatus: 200, latencyMs: 40 });
        c.requestFinished({ route: '/api/posts/:id', method: 'GET', httpStatus: 500, latencyMs: 30 });
        c.requestFinished({ route: '/api/posts', method: 'POST', httpStatus: 201, latencyMs: 7 });
        c.requestFinished({ route: undefined, method: 'GET', httpStatus: 404, latencyMs: 2 });
        c.requestFinished({ route: '/stream', method: 'TRACE', httpStatus: 0, latencyMs: NaN });

        await c.flush();
        assert.equal(batches.length, 1, 'one flush is one sink call');
        const requests = samples().filter((s) => s.operation === 'http.request');
        assert.equal(requests.length, 5, 'route|method|status_class keys: two GET /:id by class, POST, unmatched, TRACE');
        const byKey = Object.fromEntries(requests.map((s) => [`${s.resource}|${s.extra.method}|${s.extra.status_class}`, s]));
        const ok = byKey['/api/posts/:id|GET|2xx'];
        assert.deepEqual(ok.extra, { method: 'GET', status_class: '2xx', count: 2, sum_ms: 52, max_ms: 40, p95_ms: 40, http_status: 200 });
        assert.equal(ok.latency_ms, 26, 'latency_ms is the mean');
        assert.equal(ok.status, '2xx');
        assert.deepEqual(byKey['/api/posts/:id|GET|5xx'].extra, { method: 'GET', status_class: '5xx', count: 1, sum_ms: 30, max_ms: 30, p95_ms: 30, http_status: 500 });
        assert.deepEqual(byKey['/api/posts|POST|2xx'].extra.method, 'POST');
        assert.deepEqual(byKey['unmatched|GET|4xx'].extra.http_status, 404);
        assert.equal(byKey['/stream|OTHER|aborted'].extra.status_class, 'aborted', 'a non-method and an aborted status are labelled');

        assert.equal(samples().find((s) => s.operation === 'http.active_requests').extra.last, 0, 'all requests ended');
        assert.equal(samples().find((s) => s.operation === 'http.latency_p95_ms').latency_ms, 40);
        assert.equal(samples().find((s) => s.operation === 'http.eventloop_lag_ms').extra.value, 9.5);
        assert.ok(!('latency_ms' in samples().find((s) => s.operation === 'http.active_requests')), 'an extra gauge is never a latency');
        if (contracts) for (const s of samples()) assert.deepEqual(svc.validateTelemetrySample(s), { ok: true, errors: [] }, s.operation);
        else console.log('telemetry sample validation: skipped (openvibe-contracts not installed: npm install)');
    }],

    ['the gauges are emitted once per flush, from the timer not per request', async () => {
        const { c, batches, samples } = collector({ signals: { start() {}, stop() {}, lag() { return null; } } });
        c.requestStarted();          // one in flight when the interval drains: the peak is 1
        c.requestFinished({ route: '/a', method: 'GET', httpStatus: 200, latencyMs: 5 });
        c.requestStarted();
        c.requestFinished({ route: '/a', method: 'GET', httpStatus: 200, latencyMs: 5 });
        await c.flush();
        assert.deepEqual(samples().find((s) => s.operation === 'http.active_requests').extra, { last: 0, max: 1 }, 'the interval peak, sampled at start');
        assert.equal(samples().filter((s) => s.operation === 'http.active_requests').length, 1, 'one active gauge for the interval, not per request');
        assert.equal(samples().filter((s) => s.operation === 'http.latency_p95_ms').length, 1);
        assert.equal(samples().filter((s) => s.operation === 'http.eventloop_lag_ms').length, 0, 'no lag reading: no gauge');

        c.requestStarted();          // still in flight at the next flush: activeMax starts from it
        await c.flush();
        assert.deepEqual(samples().filter((s) => s.operation === 'http.active_requests').at(-1).extra, { last: 1, max: 1 });
        assert.equal(samples().filter((s) => s.operation === 'http.latency_p95_ms').length, 1, 'no latencies this interval: no p95 gauge');
    }],

    ['stop() flushes once, is idempotent, and flush() after stop changes nothing', async () => {
        const { c, batches, samples } = collector();
        c.requestStarted();
        c.requestFinished({ route: '/a', method: 'GET', httpStatus: 200, latencyMs: 5 });
        await c.stop();
        assert.equal(batches.length, 1, 'stop flushes once');
        assert.equal(samples().filter((s) => s.operation === 'http.request').length, 1, 'the interval was emitted before the flush');
        assert.equal(samples().find((s) => s.operation === 'http.active_requests').extra.last, 0);
        await c.stop();
        await c.flush();
        assert.equal(batches.length, 1, 'a second stop/flush is a no-op');
        assert.equal(samples().length, 3, 'http.request + active + p95 (no lag signal)');
    }],

    ['the middleware observes a real request by route template, skips health, and next() runs once', async () => {
        const { c, samples } = collector();
        const nextCalls = [];
        const mw = c.middleware();
        const { server, url } = await listen((req, res) => {
            if (req.url.startsWith('/api/posts/')) req.route = { path: '/api/posts/:id' };
            mw(req, res, () => { nextCalls.push(req.url); res.end('ok'); });
        });
        try {
            assert.equal(await get(`${url}/api/posts/1`), 200);
            assert.equal(await get(`${url}/api/posts/2`), 200);
            assert.equal(await get(`${url}/api/health`), 200);
            assert.equal(await get(`${url}/missing`), 200);            // the stub answers 200 for any path
            await c.flush();
            const requests = samples().filter((s) => s.operation === 'http.request');
            const posts = requests.find((s) => s.resource === '/api/posts/:id');
            assert.equal(posts.extra.count, 2, 'the route template aggregates both ids');
            assert.deepEqual([posts.extra.method, posts.extra.status_class, posts.extra.http_status], ['GET', '2xx', 200]);
            assert.ok(!requests.some((s) => s.resource === '/api/health'), 'health was skipped before counting');
            assert.ok(nextCalls.includes('/api/health'), 'a skipped request still reached the app');
            assert.equal(nextCalls.length, 4, 'next() ran once per request');
        } finally {
            server.close();
        }
    }],

    ['registerSignals injects the lag a default collector reads (the monitor is not started by require)', async () => {
        assert.equal(svc.eventLoopMonitorEnabled(), false, 'requiring the kit starts no monitor');
        svc.registerSignals({ lag: () => 4.25 });
        try {
            const { c, samples } = collector({ signals: undefined });   // no injection: the module signals
            await c.flush();
            assert.equal(samples().find((s) => s.operation === 'http.eventloop_lag_ms').extra.value, 4.25);
        } finally {
            svc.registerSignals({ start: svc.startEventLoopMonitor, stop: svc.stopEventLoopMonitor, lag: svc.eventLoopLagMs });
        }
    }],

    ['the singleton: init starts the loop monitor and timer, stop stops both and flushes once', async () => {
        const batches = [];
        const fakeRes = { finished: true, statusCode: 204, once() {} };
        let next = 0;
        svc.telemetryMiddleware({ url: '/x' }, fakeRes, () => { next += 1; });    // before init: a no-op
        assert.equal(next, 1);

        const c = svc.telemetry.init({ service: 'demo', sink: async (s) => { batches.push(s); }, intervalMs: 3600e3, log: quiet });
        assert.equal(typeof c.stop, 'function');
        assert.equal(svc.eventLoopMonitorEnabled(), true, 'init starts the monitor');
        svc.telemetry.record('boot', 1);
        svc.telemetry.requestFinished({ route: '/x', method: 'GET', httpStatus: 204, latencyMs: 3 });
        assert.equal(await svc.telemetry.flush(), undefined);
        const emitted = batches.flat();
        assert.ok(emitted.some((s) => s.operation === 'boot'));
        assert.ok(emitted.some((s) => s.operation === 'http.request' && s.resource === '/x'));

        await svc.telemetry.stop();
        assert.equal(svc.eventLoopMonitorEnabled(), false, 'stop stops the monitor');
        assert.equal(batches.length, 2, 'init flush + stop flush');
        assert.equal(svc.telemetry.record('after', 1), undefined, 'after stop the singleton is a no-op');
        await svc.telemetry.stop();                                              // idempotent
        assert.equal(batches.length, 2);
    }],

    ['defaultRouteLabel is the matched template or unmatched, never a raw path', async () => {
        assert.equal(svc.defaultRouteLabel({ route: { path: '/api/posts/:id' }, baseUrl: '/v1', path: '/v1/api/posts/7' }), '/v1/api/posts/:id');
        assert.equal(svc.defaultRouteLabel({ route: { path: '/' }, baseUrl: '' }), '/');
        assert.equal(svc.defaultRouteLabel({ path: '/etc/passwd', url: '/etc/passwd' }), 'unmatched', 'a request with no matched route is never labelled by its path');
        assert.equal(svc.defaultRouteLabel({ url: '/wp-login.php?x=1' }), 'unmatched', 'a scanner path is not a label');
        assert.equal(svc.defaultRouteLabel(null), 'unmatched');
    }],

    ['1000 distinct 404 paths produce one unmatched key', async () => {
        const { c, samples } = collector();
        for (let i = 0; i < 1000; i += 1) {
            const route = svc.defaultRouteLabel({ path: `/missing/${i}`, url: `/missing/${i}?q=${i}` });
            c.requestFinished({ route, method: 'GET', httpStatus: 404, latencyMs: 1 });
        }
        await c.flush();
        const requests = samples().filter((s) => s.operation === 'http.request');
        assert.equal(requests.length, 1, 'all unmatched paths share one key');
        assert.equal(requests[0].resource, 'unmatched');
        assert.equal(requests[0].extra.status_class, '4xx');
        assert.equal(requests[0].extra.count, 1000, 'the count stays exact across the shared key');
    }],

    ['distinct matched templates past the per-flush cap fold into the other key', async () => {
        const { c, samples } = collector({ maxRouteKeys: 3 });
        for (let i = 0; i < 6; i += 1) c.requestFinished({ route: `/api/r${i}/:id`, method: 'GET', httpStatus: 200, latencyMs: 1 });
        await c.flush();
        const requests = samples().filter((s) => s.operation === 'http.request');
        assert.equal(requests.length, 4, 'the cap of distinct templates plus the one overflow bucket');
        assert.equal(requests.filter((s) => s.resource !== 'other').length, 3, 'the first maxRouteKeys templates keep their labels');
        const other = requests.find((s) => s.resource === 'other');
        assert.equal(other.extra.count, 3, 'every later template folds into other');
    }],

    ['skipPrefixes defaults to /shared and is overridable', async () => {
        assert.equal(svc.telemetrySkipped({ path: '/shared/data', url: '/shared/data' }), true, 'the default prefix');
        assert.equal(svc.telemetrySkipped({ path: '/shared', url: '/shared' }), true, 'the prefix itself');
        assert.equal(svc.telemetrySkipped({ path: '/sharedness', url: '/sharedness' }), false, 'not a path segment');
        assert.equal(svc.telemetrySkipped({ path: '/shared/data', url: '/shared/data' }, { prefixes: [] }), false, 'overridable with []');
        assert.equal(svc.telemetrySkipped({ path: '/api/chrome/x', url: '/api/chrome/x' }, { prefixes: ['/shared', '/api/chrome'] }), true, "Network's two prefixes");
        assert.equal(svc.telemetrySkipped({ path: '/api/chrome/x', url: '/api/chrome/x' }), false, 'only /shared is the SDK default');

        const { c, samples } = collector();
        const mw = c.middleware();
        const { server, url } = await listen((req, res) => { mw(req, res, () => res.end('ok')); });
        try {
            assert.equal(await get(`${url}/shared/data`), 200);
            assert.equal(await get(`${url}/api/posts`), 200);
            await c.flush();
            assert.ok(!samples().some((s) => typeof s.resource === 'string' && s.resource.startsWith('/shared')), 'a default collector skips /shared before counting');
            assert.ok(samples().some((s) => s.resource === 'unmatched'), 'a non-skipped unmatched request is still counted');
        } finally {
            server.close();
        }
    }],

    ['50k requests keep the latency buffers at the cap with the count exact', async () => {
        const { c, samples } = collector();
        for (let i = 0; i < 50000; i += 1) c.requestFinished({ route: '/api/x', method: 'GET', httpStatus: 200, latencyMs: (i % 100) + 1 });
        const stats = c.bufferStats();
        assert.deepEqual(stats, { keys: 1, latencies: svc.LATENCY_SAMPLE_CAP, maxKeyLatencies: svc.LATENCY_SAMPLE_CAP }, 'arrays capped at 10k');
        await c.flush();
        const s = samples().find((x) => x.operation === 'http.request');
        assert.equal(s.extra.count, 50000, 'the count is exact');
        assert.equal(s.extra.max_ms, 100, 'the max is exact');
        assert.equal(s.extra.sum_ms, 2525000, 'the sum is exact (1..100, 500 times each)');
        assert.equal(s.latency_ms, 50.5, 'the mean is exact');
        assert.ok(s.extra.p95_ms >= 1 && s.extra.p95_ms <= 100, 'the p95 comes from the bounded sample');
        assert.deepEqual(c.bufferStats(), { keys: 0, latencies: 0, maxKeyLatencies: 0 }, 'a flush resets the buffers');
    }],

    ['init stops the previous collector: its interval is flushed and its timer replaced', async () => {
        const first = [];
        const second = [];
        const sinkOf = (batches) => async (s) => { batches.push(s); };
        const c1 = svc.telemetry.init({ service: 'demo', sink: sinkOf(first), intervalMs: 3600e3, log: quiet, signals: noSignals });
        svc.telemetry.requestFinished({ route: '/old', method: 'GET', httpStatus: 200, latencyMs: 4 });
        const c2 = svc.telemetry.init({ service: 'demo', sink: sinkOf(second), intervalMs: 3600e3, log: quiet, signals: noSignals });
        assert.notEqual(c2, c1);
        await new Promise((r) => setTimeout(r, 20));      // previous.stop() flushes asynchronously
        assert.ok(first.flat().some((s) => s.operation === 'http.request' && s.resource === '/old'), 'the replaced interval was flushed to the old sink');
        assert.equal(second.flat().length, 0, 'the new sink saw nothing yet');

        svc.telemetry.requestFinished({ route: '/new', method: 'GET', httpStatus: 200, latencyMs: 2 });
        await svc.telemetry.flush();
        assert.ok(second.flat().some((s) => s.operation === 'http.request' && s.resource === '/new'), 'the singleton routes into the new collector');
        assert.ok(!second.flat().some((s) => s.resource === '/old'), 'the old interval did not leak into the new collector');
        await svc.telemetry.stop();
    }],

    ['DEFAULT_INTERVAL_MS is the 15 s flush interval', async () => {
        assert.equal(svc.DEFAULT_INTERVAL_MS, 15000);
        assert.equal(svc.DEFAULT_MAX_ROUTE_KEYS, 500);
        assert.equal(svc.LATENCY_SAMPLE_CAP, 10000);
        assert.deepEqual(svc.DEFAULT_SKIP_PREFIXES, ['/shared']);
    }],
]);
