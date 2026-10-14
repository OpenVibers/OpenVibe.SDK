'use strict';
/**
 * openvibe-sdk/telemetry's PostgreSQL sink: telemetrySchema() DDL, createPgTelemetrySink() (one multi-row
 * INSERT per flush, malformed samples dropped with a warning, a db rejection propagated) and pruneTelemetry().
 * PGlite is the database.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createDb } = require('../src/db');
const { telemetrySample, createTelemetry, telemetrySchema, createPgTelemetrySink, pruneTelemetry, startTelemetryRetention } = require('../src/telemetry');

const COLUMNS = ['id', 'at', 'service', 'project', 'subject', 'resource', 'provider', 'node', 'cell', 'region', 'operation',
    'latency_ms', 'queue_delay_ms', 'ttfb_ms', 'throughput_per_second', 'bytes', 'status', 'cache_status',
    'cost_estimate', 'route_epoch', 'trace_id', 'extra'];

function logger() {
    const warns = [];
    return { warns, warn: (m) => warns.push(String(m)), error() {}, log() {} };
}

async function open(table) {
    const db = createDb({ pglite: true });
    await db.query(telemetrySchema(table));
    return db;
}

const full = (i) => telemetrySample({
    service: 'blog', project: 'prj_1', subject: 'usr_1', resource: '/api/posts/:id', provider: 'ovh', node: 'n1',
    cell: 'c1', region: 'eu-west', operation: 'http.request', at: `2026-10-13T10:00:0${i}.000Z`, latency_ms: 12.5 + i,
    queue_delay_ms: 1, ttfb_ms: 3, throughput_per_second: 40, bytes: 1024 + i, status: '2xx', cache_status: 'miss',
    cost_estimate: 0.001, route_epoch: 7, trace_id: `trace-${i}`, extra: { count: 5 + i, method: 'GET' },
});

run([
    ['telemetrySchema() runs on PGlite (twice: idempotent) and has the columns in schema order, plus two indexes', async () => {
        const db = await open();
        try {
            await db.query(telemetrySchema());
            const cols = await db.many(`SELECT column_name FROM information_schema.columns WHERE table_name = 'telemetry_samples' ORDER BY ordinal_position`);
            assert.deepEqual(cols.map((c) => c.column_name), COLUMNS);
            const idx = await db.many(`SELECT indexname FROM pg_indexes WHERE tablename = 'telemetry_samples' ORDER BY indexname`);
            assert.deepEqual(idx.map((r) => r.indexname), ['telemetry_samples_at_idx', 'telemetry_samples_pkey', 'telemetry_samples_service_idx']);
        } finally { await db.close(); }
    }],

    ['the sink inserts N rows with one INSERT, every field in its column and extra JSON-encoded', async () => {
        const db = await open();
        const queries = [];
        const spy = { query: (text, values) => { queries.push({ text, values }); return db.query(text, values); } };
        try {
            const log = logger();
            await createPgTelemetrySink({ db: spy, log })([full(0), full(1), full(2)]);
            assert.equal(queries.length, 1);
            assert.match(queries[0].text, /^INSERT INTO telemetry_samples \(at, service, project, .*, trace_id, extra\) VALUES /);
            assert.equal(queries[0].values.length, 3 * 21);
            assert.equal(queries[0].values[20], JSON.stringify({ count: 5, method: 'GET' }));
            assert.deepEqual(log.warns, []);
            const rows = await db.many('SELECT * FROM telemetry_samples ORDER BY id');
            assert.equal(rows.length, 3);
            rows.forEach((r, i) => {
                const { id, ...stored } = r;
                assert.ok(id);
                assert.deepEqual(stored, { ...full(i) });
            });
        } finally { await db.close(); }
    }],

    ['missing fields are NULL and a missing extra is {}', async () => {
        const db = await open();
        try {
            await createPgTelemetrySink({ db, log: logger() })([{ service: 'blog', operation: 'cache.miss', at: '2026-10-13T10:00:00.000Z' }]);
            const r = await db.one('SELECT * FROM telemetry_samples');
            for (const c of COLUMNS) {
                if (['id', 'at', 'service', 'operation', 'extra'].includes(c)) continue;
                assert.equal(r[c], null, c);
            }
            assert.deepEqual(r.extra, {});
        } finally { await db.close(); }
    }],

    ['a malformed sample is dropped with one warning and the rest of the batch is stored', async () => {
        const db = await open();
        try {
            const log = logger();
            const bad = [null, { operation: 'x', at: '2026-10-13T10:00:00Z' }, { ...full(1), at: 'yesterday' },
                { ...full(2), latency_ms: '12' }, { ...full(3), bytes: 1.5 }, { ...full(4), extra: [1] }, { ...full(5), status: 200 }];
            await createPgTelemetrySink({ db, log })([full(0), ...bad, full(6)]);
            assert.equal(log.warns.length, 1);
            assert.match(log.warns[0], /dropped 7 malformed sample\(s\), stored 2/);
            const rows = await db.many('SELECT trace_id FROM telemetry_samples ORDER BY id');
            assert.deepEqual(rows.map((r) => r.trace_id), ['trace-0', 'trace-6']);
            // A batch with nothing storable inserts nothing (and does not query).
            await createPgTelemetrySink({ db: { query: () => { throw new Error('queried'); } }, log })([null]);
            await createPgTelemetrySink({ db: { query: () => { throw new Error('queried'); } }, log })([]);
        } finally { await db.close(); }
    }],

    ['a bad table name throws, so no SQL goes in through it', async () => {
        const db = { query: async () => ({ rows: [], rowCount: 0 }) };
        for (const t of ['bad-name', 'x; DROP TABLE users', 'Upper', '1abc', '', 'a'.repeat(64), 'public.t', null]) {
            assert.throws(() => telemetrySchema(t), /bad telemetry table name/, String(t));
            assert.throws(() => createPgTelemetrySink({ db, table: t }), /bad telemetry table name/, String(t));
            await assert.rejects(pruneTelemetry({ db, table: t }), /bad telemetry table name/, String(t));
        }
        assert.match(telemetrySchema('blog_telemetry'), /CREATE TABLE IF NOT EXISTS blog_telemetry \(/);
        assert.throws(() => createPgTelemetrySink({}), /db handle/);
    }],

    ['a rejected db.query propagates, and createTelemetry keeps the batch for its next flush', async () => {
        const failing = { query: async () => { throw new Error('connection refused'); } };
        await assert.rejects(createPgTelemetrySink({ db: failing, log: logger() })([full(0)]), /connection refused/);

        const db = await open('svc_telemetry');
        try {
            let down = true;
            const flaky = { query: (text, values) => (down ? Promise.reject(new Error('down')) : db.query(text, values)) };
            const log = logger();
            const t = createTelemetry({ service: 'blog', sink: createPgTelemetrySink({ db: flaky, table: 'svc_telemetry', log }), log, intervalMs: 3600e3 });
            t.record('http.request', 10, { status: '2xx', extra: { count: 1 } });
            await t.flush();
            assert.equal(await db.value('SELECT count(*)::int FROM svc_telemetry'), 0);
            down = false;
            await t.stop();
            const r = await db.one('SELECT service, operation, latency_ms, status, extra FROM svc_telemetry');
            assert.deepEqual(r, { service: 'blog', operation: 'http.request', latency_ms: 10, status: '2xx', extra: { count: 1 } });
        } finally { await db.close(); }
    }],

    ['pruneTelemetry deletes rows older than 30 days by default and keeps the rest', async () => {
        const db = await open();
        try {
            const day = 86400e3;
            const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
            await createPgTelemetrySink({ db, log: logger() })([40, 31, 29, 1].map((d) => ({ service: 'blog', operation: `d${d}`, at: at(d) })));
            assert.equal(await pruneTelemetry({ db }), 2);
            assert.deepEqual((await db.many('SELECT operation FROM telemetry_samples ORDER BY id')).map((r) => r.operation), ['d29', 'd1']);
            assert.equal(await pruneTelemetry({ db, olderThanDays: 7 }), 1);
            await assert.rejects(pruneTelemetry({ db, olderThanDays: 0 }), /olderThanDays/);
        } finally { await db.close(); }
    }],

    ['startTelemetryRetention prunes soon after start (not a day later), then again, logs a failure and stops', async () => {
        const db = await open();
        try {
            const old = new Date(Date.now() - 40 * 86400e3).toISOString();
            await createPgTelemetrySink({ db, log: logger() })([{ service: 'blog', operation: 'old', at: old }, { service: 'blog', operation: 'new', at: new Date().toISOString() }]);
            const errors = [];
            const r = startTelemetryRetention({ db, delayMs: 20, everyMs: 60, log: { error: (m) => errors.push(String(m)) } });
            await new Promise((ok) => setTimeout(ok, 250));
            assert.deepEqual((await db.many('SELECT operation FROM telemetry_samples')).map((x) => x.operation), ['new']);
            assert.equal(errors.length, 0);
            assert.equal(await r.run(), 0);
            await r.stop();
            await createPgTelemetrySink({ db, log: logger() })([{ service: 'blog', operation: 'old2', at: old }]);
            await new Promise((ok) => setTimeout(ok, 150));
            assert.equal(await db.value('SELECT count(*)::int FROM telemetry_samples'), 2, 'nothing prunes after stop()');
            const bad = startTelemetryRetention({ db: { query: async () => { throw new Error('db down'); } }, delayMs: 5, everyMs: 1000, log: { error: (m) => errors.push(String(m)) } });
            assert.equal(await bad.run(), 0);
            await bad.stop();
            assert.match(errors[0], /retention prune failed: db down/);
            assert.throws(() => startTelemetryRetention({ db, everyMs: 0 }), /everyMs/);
            assert.throws(() => startTelemetryRetention({ db, table: 'x; drop' }), /bad telemetry table name/);
        } finally { await db.close(); }
    }],
]);
