'use strict';
/**
 * openvibe-sdk/telemetry — platform.telemetry-sample@1, the universal operation observation every service
 * can emit (T1 Universal Fabric): one sample schema for routing and autoscaling, product dimensions in extra.
 * No I/O and no dependency at require time: the sink is the service's (the SDK holds no network code), and
 * openvibe-contracts is required lazily by validateTelemetrySample, the way src/service re-exports its packages.
 *
 *   const { telemetrySample, validateTelemetrySample, createTelemetry } = require('openvibe-sdk/telemetry');
 *   const t = createTelemetry({ service: 'media', instance: 'i-1', sink: (samples) => post('/telemetry', samples) });
 *   t.record('deliver', 28, { subject, resource, status: 'ok' });   // { service, instance, operation, at, latency_ms, ...labels }
 *   t.count('cache.miss');                                          // a convenience wrapper around record()
 *   stop: [() => t.stop()],                                          // a gracefulStop stop step: one flush
 */

/** The fields platform.telemetry-sample@1 requires or allows, in the schema's order; null/undefined are stripped. */
function telemetrySample(fields) {
    const f = fields || {};
    const record = {
        service: f.service,
        project: f.project,
        subject: f.subject,
        resource: f.resource,
        provider: f.provider,
        node: f.node,
        cell: f.cell,
        region: f.region,
        operation: f.operation,
        at: f.at == null ? new Date().toISOString() : f.at,
        latency_ms: f.latency_ms,
        queue_delay_ms: f.queue_delay_ms,
        ttfb_ms: f.ttfb_ms,
        throughput_per_second: f.throughput_per_second,
        bytes: f.bytes,
        status: f.status,
        cache_status: f.cache_status,
        cost_estimate: f.cost_estimate,
        route_epoch: f.route_epoch,
        trace_id: f.trace_id,
        extra: f.extra,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** { ok, errors } for a record against platform.telemetry-sample@1. A missing openvibe-contracts is never a
 *  claim of validity: ok is false and errors stay empty (nothing was checked). */
function validateTelemetrySample(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed: nothing to check against */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.telemetry-sample@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

/**
 * A collector: it buffers samples and flushes them to `await sink(samples)` every `intervalMs` (an unref'd
 * timer, so it never holds the process open) and on stop(). A sink that rejects is logged once per attempt
 * and its samples kept for the next flush; past `maxBuffered` the oldest sample is dropped, with a warning
 * at most once a minute. `stop()` clears the timer and flushes once, so it can serve as a gracefulStop stop step.
 */
function createTelemetry({ service = null, instance = null, sink = null, intervalMs = 15000, now = () => Date.now(), log = console, maxBuffered = 1000 } = {}) {
    if (typeof sink !== 'function') throw new TypeError('createTelemetry: a sink(samples) function is required');
    if (!service) log.warn('[telemetry] createTelemetry() without `service`: samples lack the service platform.telemetry-sample@1 requires');

    let buffer = [];
    let flushing = null;
    let dropped = 0;
    let lastWarn = -Infinity;

    function warnDropped() {
        const t = now();
        if (t - lastWarn < 60e3) return;   // at most one warning per minute
        lastWarn = t;
        log.warn(`[telemetry] buffer over ${maxBuffered}: dropped the oldest sample (${dropped} dropped so far)`);
    }

    function push(sample) {
        buffer.push(sample);
        while (buffer.length > maxBuffered) {
            buffer.shift();
            dropped += 1;
            warnDropped();
        }
    }

    /** `{ service, instance, operation: name, at, latency_ms: value, ...labels }`; a value that is not a
     *  number goes to `extra[name]` as a scalar (a product dimension, never a payload or a secret). */
    function record(name, value, labels = {}) {
        const { extra, ...rest } = labels || {};
        const base = { service, instance, operation: name, at: new Date(now()).toISOString(), ...rest };
        const sample = typeof value === 'number' ? { ...base, latency_ms: value, extra } : { ...base, extra: { [name]: value, ...(extra || {}) } };
        for (const k of Object.keys(sample)) if (sample[k] == null) delete sample[k];
        push(sample);
        return sample;
    }

    /** A gauge's level (memory in use, queue depth) and a counter's tick are samples like any other. */
    function gauge(name, value, labels) { return record(name, value, labels); }
    function count(name, labels) { return record(name, 1, labels); }

    /** Await the sink for everything buffered; a rejection is logged once and the samples kept for the next flush. */
    async function flush() {
        if (flushing) return flushing;
        if (!buffer.length) return;
        const batch = buffer;
        buffer = [];
        flushing = (async () => {
            try {
                await sink(batch);
            } catch (err) {
                log.error(`[telemetry] sink rejected ${batch.length} samples (${err && err.message ? err.message : err}); kept for the next flush`);
                buffer = [...batch, ...buffer];
                while (buffer.length > maxBuffered) {
                    buffer.shift();
                    dropped += 1;
                    warnDropped();
                }
            } finally {
                flushing = null;
            }
        })();
        return flushing;
    }

    const timer = setInterval(() => { flush(); }, intervalMs);
    if (timer.unref) timer.unref();

    let stopped = false;
    /** Clears the timer and flushes once (a gracefulStop stop step; a second stop changes nothing). */
    async function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        await flush();
    }

    return { record, gauge, count, flush, stop };
}

module.exports = { telemetrySample, validateTelemetrySample, createTelemetry };
