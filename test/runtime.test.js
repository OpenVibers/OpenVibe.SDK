'use strict';
/** openvibe-sdk/runtime: platform.runtime-offer@1 and platform.runtime-class@1 — build and validate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { runtimeOffer, runtimeClass, RUNTIME_CLASSES, validateRuntimeOffer, validateRuntimeClass } = require('../src/runtime');

const FIXTURES_RO = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.runtime-offer');
const FIXTURES_RC = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.runtime-class');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }
if (contracts && ![FIXTURES_RO, FIXTURES_RC].every((dir) =>
    fs.existsSync(path.join(dir, 'valid')) && fs.existsSync(path.join(dir, 'invalid')))) contracts = null;

run([
    ['runtimeOffer passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('runtime-offer fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RO, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_RO, 'valid', f), 'utf8'));
            assert.deepEqual(runtimeOffer({ ...fixture }), fixture, f);
            assert.deepEqual(validateRuntimeOffer(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['runtimeOffer strips null/undefined', async () => {
        const o = runtimeOffer({ id: 'r1', kind: 'container', region: 'us-west', node: 'n1',
            limits: { cpu_cores: 2, memory_mb: 4096 }, price: { amount_usd: 0.05, unit: 'hour' },
            availability: null, constraints: undefined });
        assert.ok(!('availability' in o), 'null availability stripped');
        assert.ok(!('constraints' in o), 'undefined constraints stripped');
    }],
    ['validateRuntimeOffer refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('runtime-offer invalid fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RO, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_RO, 'invalid', f), 'utf8'));
            const r = validateRuntimeOffer(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['runtimeClass accepts every valid fixture and rejects every invalid one', async () => {
        if (!contracts) { console.log('runtime-class fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RC, 'valid'))) {
            const value = JSON.parse(fs.readFileSync(path.join(FIXTURES_RC, 'valid', f), 'utf8'));
            assert.equal(runtimeClass(value), value, f);
            assert.deepEqual(validateRuntimeClass(value), { ok: true, errors: [] }, f);
        }
        for (const f of fs.readdirSync(path.join(FIXTURES_RC, 'invalid'))) {
            const value = JSON.parse(fs.readFileSync(path.join(FIXTURES_RC, 'invalid', f), 'utf8'));
            assert.throws(() => runtimeClass(value), /unknown class/);
            const r = validateRuntimeClass(value);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['RUNTIME_CLASSES enumerates the known classes', async () => {
        assert.deepEqual(RUNTIME_CLASSES, ['function', 'code', 'browser', 'linux', 'desktop', 'gpu']);
    }],
]);
