'use strict';
/** openvibe-sdk/cost: platform.rate-card@1 and platform.cost-snapshot@1 — build, validate, estimate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { rateCard, costSnapshot, estimate, validateRateCard, validateCostSnapshot } = require('../src/cost');

const FIXTURES_RC = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.rate-card');
const FIXTURES_CS = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.cost-snapshot');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }

run([
    ['rateCard passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('rate-card fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
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
        if (!contracts) { console.log('rate-card invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES_RC, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_RC, 'invalid', f), 'utf8'));
            const r = validateRateCard(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['costSnapshot passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('cost-snapshot fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
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
        if (!contracts) { console.log('cost-snapshot invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
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
]);
