'use strict';
/** openvibe-sdk/telemetry: platform.telemetry-sample@1 — build, validate, and a collector that buffers and flushes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, sleep } = require('./helpers');
const { telemetrySample, validateTelemetrySample, createTelemetry } = require('../src/telemetry');

const FIXTURES = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.telemetry-sample');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }

const quiet = { log() {}, warn() {}, error() {} };
const T = Date.parse('2026-09-30T10:00:00Z');
const AT = '2026-09-30T10:00:00.000Z';

run([
    ['telemetrySample passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('telemetry fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', f), 'utf8'));
            assert.deepEqual(telemetrySample({ ...fixture }), fixture, f);
            assert.deepEqual(validateTelemetrySample(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['telemetrySample defaults at and strips null/undefined', async () => {
        const before = Date.now();
        const record = telemetrySample({ service: 'media', operation: 'deliver', at: null, subject: undefined, latency_ms: null });
        assert.deepEqual(record, { service: 'media', operation: 'deliver', at: record.at });
        assert.ok(Date.parse(record.at) >= before, 'at defaults to now');
        const zero = telemetrySample({ service: 'media', operation: 'deliver', at: AT, latency_ms: 0, route_epoch: 0, extra: {} });
        assert.equal(zero.latency_ms, 0); assert.equal(zero.route_epoch, 0); assert.deepEqual(zero.extra, {}, 'a 0 and {} are kept, not stripped');
    }],
    ['validateTelemetrySample refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('telemetry invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid', f), 'utf8'));
            const r = validateTelemetrySample(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['the collector flushes on the interval and on stop, with the sample record() builds', async () => {
        const flushed = [];
        const t = createTelemetry({ service: 'media', instance: 'i-1', sink: async (samples) => { flushed.push(...samples); },
            intervalMs: 30, now: () => T, log: quiet });
        const sample = t.record('deliver', 28, { subject: 'user:u1', resource: 'object-1', status: 'ok', trace_id: 'tr-42' });
        assert.deepEqual(sample, { service: 'media', instance: 'i-1', operation: 'deliver', at: AT, latency_ms: 28,
            subject: 'user:u1', resource: 'object-1', status: 'ok', trace_id: 'tr-42' });
        await sleep(90);                                            // the unref'd interval fired
        assert.equal(flushed.length, 1);
        assert.deepEqual(flushed[0], sample);
        t.gauge('queue_depth', 4);                                  // a gauge's level
        t.count('cache.miss');                                      // a counter's tick
        t.record('mode', 'fast');                                   // a non-number value goes to extra[name]
        await t.stop();                                             // flushes once, timer cleared
        assert.equal(flushed.length, 4);
        assert.deepEqual(flushed[1], { service: 'media', instance: 'i-1', operation: 'queue_depth', at: AT, latency_ms: 4 });
        assert.deepEqual(flushed[2], { service: 'media', instance: 'i-1', operation: 'cache.miss', at: AT, latency_ms: 1 });
        assert.deepEqual(flushed[3], { service: 'media', instance: 'i-1', operation: 'mode', at: AT, extra: { mode: 'fast' } });
        await sleep(60);                                            // the timer is cleared: nothing more flushes
        assert.equal(flushed.length, 4);
        await t.stop();                                             // a second stop changes nothing
        assert.equal(flushed.length, 4);
    }],
    ['the collector bounds its buffer, drops the oldest and warns once per minute', async () => {
        const warns = [];
        const flushed = [];
        let clock = T;
        const t = createTelemetry({ service: 'media', sink: async (samples) => { flushed.push(...samples); },
            intervalMs: 3600e3, now: () => clock, log: { warn: (...a) => warns.push(a.join(' ')), error() {} }, maxBuffered: 3 });
        t.record('a', 1); t.record('b', 2); t.record('c', 3);       // exactly maxBuffered: nothing dropped yet
        assert.equal(warns.length, 0);
        t.record('d', 4); t.record('e', 5);                          // past the bound: the oldest go, one warning
        assert.equal(warns.length, 1);
        assert.match(warns[0], /dropped/);
        clock += 61e3;                                               // a minute later the warning is allowed again
        t.record('f', 6);
        assert.equal(warns.length, 2);
        clock += 1e3;                                                // within the minute: counted, not repeated
        t.record('g', 7);
        assert.equal(warns.length, 2);
        await t.stop();
        assert.deepEqual(flushed.map((s) => s.operation), ['e', 'f', 'g'], 'the oldest samples were dropped');
    }],
    ['a rejecting sink is logged once per attempt and its samples kept for the next flush', async () => {
        const errors = [];
        let calls = 0;
        const t = createTelemetry({ service: 'media', sink: async () => { calls += 1; throw new Error('boom'); },
            intervalMs: 3600e3, now: () => T, log: { warn() {}, error: (...a) => errors.push(a.join(' ')) } });
        t.record('deliver', 5);
        await t.stop();                                              // must not reject
        assert.equal(calls, 1);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /boom/);
        await t.flush();                                             // the buffer was kept, not lost
        assert.equal(calls, 2);
        assert.equal(errors.length, 2);
    }],
    ['createTelemetry requires a sink, and warns once without a service', async () => {
        const warns = [];
        assert.throws(() => createTelemetry({ service: 'media', log: quiet }), /sink/);
        const t = createTelemetry({ sink: () => {}, log: { warn: (...a) => warns.push(a.join(' ')), error() {} } });
        assert.equal(warns.length, 1);
        assert.match(warns[0], /service/);
        t.record('deliver', 1);                                      // still works, like a governor without service
        assert.ok(!('service' in t.record('deliver', 2)));
        await t.stop();
    }],
]);
