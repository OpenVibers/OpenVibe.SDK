'use strict';
/** openvibe-sdk/usage: platform.usage-sample@1 — build, key, validate; govern emits the same record through it. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { usageSample, usageKey, validateUsageSample } = require('../src/usage');
const { createGovernor } = require('../src/govern');

const FIXTURES = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.usage-sample');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }

const quiet = { log() {}, warn() {}, error() {} };

run([
    ['usageSample passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('usage fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', f), 'utf8'));
            assert.deepEqual(usageSample({ ...fixture }), fixture, f);
            assert.deepEqual(validateUsageSample(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['usageSample defaults at and source, strips null/undefined and invents no money field', async () => {
        const before = Date.now();
        const record = usageSample({ id: 'use-9', idempotency_key: 'media:delivery:9', service: 'media', operation: 'deliver',
            quantity: 1, unit: 'GiB', at: null, source: undefined, project: null, region: undefined, cost_estimate: null });
        assert.deepEqual(Object.keys(record), ['id', 'idempotency_key', 'service', 'operation', 'quantity', 'unit', 'at', 'source']);
        assert.ok(Date.parse(record.at) >= before, 'at defaults to now');
        assert.equal(record.source, 'openvibe-sdk/usage');
        for (const k of ['cost_estimate', 'free_allowance_used', 'vibes_charged', 'project', 'region']) assert.ok(!(k in record), k);
        const passed = usageSample({ id: 'use-8', idempotency_key: 'k', service: 'media', operation: 'deliver', quantity: 0,
            unit: 'GiB', at: '2026-09-30T10:00:00Z', source: 'media.egress', route_epoch: 0 });
        assert.equal(passed.quantity, 0); assert.equal(passed.route_epoch, 0, 'a 0 is kept, not stripped');
    }],
    ['validateUsageSample refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('usage invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid', f), 'utf8'));
            const r = validateUsageSample(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['usageKey joins the service and parts with :, and enforces the service', async () => {
        assert.equal(usageKey('media'), 'media');
        assert.equal(usageKey('media', 'delivery', 1), 'media:delivery:1');
        assert.equal(usageKey('run', 'job_01JAB2C3D4E5F6G7H8J9K0MNPQ', 12), 'run:job_01JAB2C3D4E5F6G7H8J9K0MNPQ:12');
        assert.throws(() => usageKey(''), /non-empty string/);
        assert.throws(() => usageKey(null), /non-empty string/);
    }],
    ['govern: onUsage emits exactly usageSample() of the same fields, and it validates', async () => {
        const policy = { 'job-run': { user: { hour: 10 } } };
        const seen = [];
        const gov = createGovernor({ policy, service: 'openvibe.test', provider: 'local', region: 'eu-1', log: quiet,
            now: () => Date.parse('2026-09-28T12:00:30Z'), onUsage: (r) => seen.push(r) });
        const res = await gov.reserve({ subject: 'user:u1', unit: 'job-run', amount: 3, key: 'usage-mod-1',
            operation: 'render', trace_id: 'tr-7', route_epoch: 2 });
        assert.equal(res.ok, true);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0], usageSample({ id: res.id, idempotency_key: 'usage-mod-1', service: 'openvibe.test', subject: 'user:u1',
            provider: 'local', region: 'eu-1', operation: 'render', quantity: 3, unit: 'job-run', at: '2026-09-28T12:00:30.000Z',
            route_epoch: 2, trace_id: 'tr-7', source: 'openvibe-sdk/govern' }));
        if (!contracts) { console.log('govern usage record: skipped validation (openvibe-contracts not installed: npm install)'); return; }
        assert.deepEqual(validateUsageSample(seen[0]), { ok: true, errors: [] });
    }],
]);
