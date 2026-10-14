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
 *
 * Where samples land: each service's own PostgreSQL table (telemetrySchema() in a migration, createPgTelemetrySink()
 * as the sink, pruneTelemetry() for retention), not a central ingest; docs/service.md says why.
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

const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function checkTable(table, who) {
    if (typeof table !== 'string' || !TABLE_RE.test(table)) throw new TypeError(`${who}: bad telemetry table name (lowercase letters, digits and _, at most 63)`);
    return table;
}

/** The table's columns in platform.telemetry-sample@1 order (no `instance`: the schema has none), then `extra`. */
const COLUMNS = ['at', 'service', 'project', 'subject', 'resource', 'provider', 'node', 'cell', 'region', 'operation',
    'latency_ms', 'queue_delay_ms', 'ttfb_ms', 'throughput_per_second', 'bytes', 'status', 'cache_status',
    'cost_estimate', 'route_epoch', 'trace_id', 'extra'];
const TEXT = new Set(['project', 'subject', 'resource', 'provider', 'node', 'cell', 'region', 'status', 'cache_status', 'trace_id']);
const NUMBER = new Set(['latency_ms', 'queue_delay_ms', 'ttfb_ms', 'throughput_per_second', 'cost_estimate']);
const INTEGER = new Set(['bytes', 'route_epoch']);
// PostgreSQL binds at most 65535 parameters per statement: past this many rows a flush takes a second INSERT.
const MAX_ROWS = Math.floor(65535 / COLUMNS.length);

/** The telemetry table's DDL, for a service migration (and tests): 21 columns, `extra` jsonb, and two indexes. */
function telemetrySchema(table = 'telemetry_samples') {
    checkTable(table, 'telemetrySchema');
    return `CREATE TABLE IF NOT EXISTS ${table} (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ${table}_at_idx ON ${table} (at);
CREATE INDEX IF NOT EXISTS ${table}_service_idx ON ${table} (service, operation, at);`;
}

/** Whether a row would insert: one bad field must not fail (and, kept by the collector, block) the whole batch. */
function storable(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    if (typeof s.service !== 'string' || !s.service || typeof s.operation !== 'string' || !s.operation) return false;
    if (typeof s.at !== 'string' || Number.isNaN(Date.parse(s.at))) return false;
    for (const c of TEXT) if (s[c] != null && typeof s[c] !== 'string') return false;
    for (const c of NUMBER) if (s[c] != null && !Number.isFinite(s[c])) return false;
    for (const c of INTEGER) if (s[c] != null && !Number.isSafeInteger(s[c])) return false;
    if (s.extra != null && (typeof s.extra !== 'object' || Array.isArray(s.extra))) return false;
    return true;
}

/**
 * A createTelemetry() / createHttpTelemetry() sink that stores each flush in `table` with one multi-row
 * parameterized INSERT (a second one only past MAX_ROWS rows). A malformed sample (no service, operation or
 * parseable `at`, or a field of the wrong type) is dropped with one warning per flush and the rest are stored;
 * a missing field is NULL, `extra` is JSON ('{}' when absent). A rejected db.query propagates, so the collector
 * logs it and keeps the batch for its next flush.
 */
function createPgTelemetrySink({ db, table = 'telemetry_samples', log = console } = {}) {
    if (!db || typeof db.query !== 'function') throw new TypeError('createPgTelemetrySink: an openvibe-sdk/db handle is required');
    checkTable(table, 'createPgTelemetrySink');
    return async function sink(samples) {
        const all = Array.isArray(samples) ? samples : [];
        const rows = all.filter(storable);
        if (rows.length < all.length) log.warn(`[telemetry] ${table}: dropped ${all.length - rows.length} malformed sample(s), stored ${rows.length}`);
        for (let start = 0; start < rows.length; start += MAX_ROWS) {
            const chunk = rows.slice(start, start + MAX_ROWS);
            const values = [];
            const tuples = chunk.map((s) => `(${COLUMNS.map((c) => {
                values.push(c === 'extra' ? JSON.stringify(s.extra || {}) : (s[c] == null ? null : s[c]));
                return `$${values.length}`;
            }).join(', ')})`);
            await db.query(`INSERT INTO ${table} (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, values);
        }
    };
}

/** Retention: deletes the rows older than `olderThanDays` (default 30) and resolves with how many went. A
 *  service runs it from a daily job or timer; the `at` index keeps it cheap. */
async function pruneTelemetry({ db, table = 'telemetry_samples', olderThanDays = 30 } = {}) {
    if (!db || typeof db.query !== 'function') throw new TypeError('pruneTelemetry: an openvibe-sdk/db handle is required');
    checkTable(table, 'pruneTelemetry');
    if (!(Number.isFinite(olderThanDays) && olderThanDays > 0)) throw new TypeError('pruneTelemetry: olderThanDays must be a positive number');
    const r = await db.query(`DELETE FROM ${table} WHERE at < now() - make_interval(secs => $1)`, [olderThanDays * 86400]);
    return r.rowCount;
}

module.exports = { telemetrySample, validateTelemetrySample, createTelemetry, telemetrySchema, createPgTelemetrySink, pruneTelemetry };
