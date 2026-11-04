'use strict';
/** openvibe-sdk/cost: platform.rate-card@1 and platform.cost-snapshot@1 — build, validate, estimate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { rateCard, costSnapshot, estimate, validateRateCard, validateCostSnapshot,
    nanoUsd, chargeTokens, expectedCostNano, costPerSuccessNano, formatNanoUsd } = require('../src/cost');

const FIXTURES_RC = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.rate-card');
const FIXTURES_CS = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.cost-snapshot');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }
if (contracts && ![FIXTURES_RC, FIXTURES_CS].every((dir) =>
    fs.existsSync(path.join(dir, 'valid')) && fs.existsSync(path.join(dir, 'invalid')))) contracts = null;

run([
    ['rateCard passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('rate-card fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RC, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_RC, 'valid', f), 'utf8'));
            assert.deepEqual(rateCard({ ...fixture }), fixture, f);
            assert.deepEqual(validateRateCard(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['rateCard strips null/undefined and keeps zero values', async () => {
        const r = rateCard({ id: 'rc', provider: 'p', metric: 'm', unit_size: 1, unit_price_usd: 0,
            free_allowance: 0, reset_period: 'month', effective_from: '2026-09-01',
            source: 'https://example.com', verified_at: '2026-09-28', adapter: null, region: undefined });
        assert.ok(!('adapter' in r), 'null adapter stripped');
        assert.ok(!('region' in r), 'undefined region stripped');
        assert.equal(r.unit_price_usd, 0, 'a 0 is kept, not stripped');
    }],
    ['validateRateCard refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('rate-card invalid fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RC, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_RC, 'invalid', f), 'utf8'));
            const r = validateRateCard(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['costSnapshot passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('cost-snapshot fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_CS, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_CS, 'valid', f), 'utf8'));
            assert.deepEqual(costSnapshot({ ...fixture }), fixture, f);
            assert.deepEqual(validateCostSnapshot(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['costSnapshot strips null/undefined', async () => {
        const s = costSnapshot({ window_start: '2026-09-28T00:00:00Z', window_end: '2026-09-29T00:00:00Z',
            scope: 'events', by_target: [], actual_usd: 0, project_id: null, counterfactual_usd: undefined });
        assert.ok(!('project_id' in s));
        assert.ok(!('counterfactual_usd' in s));
    }],
    ['validateCostSnapshot refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('cost-snapshot invalid fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_CS, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_CS, 'invalid', f), 'utf8'));
            const r = validateCostSnapshot(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['estimate: free allowance shrinks billable, unit_size prorate, cost_usd is right', async () => {
        const card = rateCard({ id: 'rc', provider: 'p', metric: 'm', unit_size: 1000, unit_price_usd: 0.5,
            free_allowance: 500, reset_period: 'month', effective_from: '2026-09-01',
            source: 'https://example.com', verified_at: '2026-09-28' });
        // 300 units: under the free allowance → billable = 0
        assert.deepEqual(estimate(card, 300, 'ops'), { quantity: 300, unit: 'ops', billable: 0, cost_usd: 0 });
        // 1500 units: 1000 billable, at 0.5 per 1000 → 0.5
        const e = estimate(card, 1500, 'ops');
        assert.equal(e.billable, 1000);
        assert.equal(e.cost_usd, 0.5);
        // null unit is carried through as null
        assert.equal(estimate(card, 100).unit, null);
    }],

    ['nano-USD money: an integer count of 1e-9 USD, never a float of dollars', async () => {
        assert.equal(nanoUsd('3000'), 3000n);
        assert.equal(nanoUsd(0), 0n);
        assert.equal(nanoUsd(null), 0n);
        assert.equal(nanoUsd(undefined), 0n);
        assert.equal(nanoUsd(''), 0n);
        assert.equal(nanoUsd(3000n), 3000n);
        assert.throws(() => nanoUsd(1.5), TypeError, 'a fractional nano-USD is a bug, not a rounding opportunity');
        assert.throws(() => nanoUsd('0.5'), TypeError);
        assert.throws(() => nanoUsd('12abc'), TypeError);
        assert.equal(formatNanoUsd(8400n), '8400');
        assert.equal(formatNanoUsd('8400'), '8400');
    }],

    ['nano-USD money: the charge of a component is ceil(tokens * rate / 1e6)', async () => {
        // 800 input tokens at 3000 nano-USD per million: 800 * 3000 = 2_400_000; / 1e6 = 2.4; ceil = 3.
        assert.equal(chargeTokens(800, '3000'), 3n);
        // 400 output tokens at 15000 nano-USD per million: 400 * 15000 = 6_000_000; / 1e6 = 6; ceil = 6.
        assert.equal(chargeTokens(400, '15000'), 6n);
        // A rate that divides exactly is not rounded up.
        assert.equal(chargeTokens(1e6, '3000'), 3000n);
        // One token at 3000 per million is 0.003 nano-USD: the whole nano-USD is charged.
        assert.equal(chargeTokens(1, '3000'), 1n);
        // Nothing to charge for nothing.
        assert.equal(chargeTokens(0, '3000'), 0n);
        assert.equal(chargeTokens(1000, '0'), 0n);
    }],

    ['nano-USD money: the expected cost adds the four token classes and the per-request fee', async () => {
        const rates = {
            input_nano_usd_per_m: '3000', cached_read_nano_usd_per_m: '300',
            cache_write_nano_usd_per_m: '3000', output_nano_usd_per_m: '15000', per_request_nano_usd: '0',
        };
        // input 800 @ 3000/M = 3; output 400 @ 15000/M = 6; the rest are 0; fee 0 => 9.
        assert.equal(expectedCostNano({ input_tokens: 800, output_tokens: 400 }, rates), 9n);
        // The per-request fee is added once.
        assert.equal(expectedCostNano({ input_tokens: 800, output_tokens: 400 }, { ...rates, per_request_nano_usd: '7' }), 16n);
        // All four classes at once:
        // input 1000 @ 3000/M = 3; cached read 2000 @ 300/M = 0.6 -> 1; cache write 500 @ 3000/M = 1.5 -> 2;
        // output 1000 @ 15000/M = 15; fee 3 => 24.
        assert.equal(expectedCostNano(
            { input_tokens: 1000, cached_read_tokens: 2000, cache_write_tokens: 500, output_tokens: 1000 },
            { ...rates, per_request_nano_usd: '3' },
        ), 24n);
        // The nested settlement shape prices the same way.
        assert.equal(expectedCostNano({ input_tokens: 800, output_tokens: 400 }, {
            nano_usd_per_m: { input: '3000', cached_read: '300', cache_write: '3000', output: '15000' },
            per_request_nano_usd: '0',
        }), 9n);
    }],

    ['nano-USD money: the cost per success is the expected cost over max(p_success, floor)', async () => {
        // 9 nano-USD at p = 0.9: 9 / 0.9 = 10.
        assert.equal(costPerSuccessNano(9n, 0.9, 0.1), 10n);
        // The floor holds it up: p = 0.01 with a floor of 0.1 gives 9 / 0.1 = 90.
        assert.equal(costPerSuccessNano(9n, 0.01, 0.1), 90n);
        // No chance of success has no cost per success.
        assert.equal(costPerSuccessNano(9n, 0, 0.1), null);
        // A probability above one is clamped to the floor's job: the divisor never goes below the floor.
        assert.equal(costPerSuccessNano(9n, 1, 0.1), 9n);
    }],
]);
