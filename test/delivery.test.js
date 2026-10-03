'use strict';
/** openvibe-sdk/delivery: platform.delivery-offer@1 — build and validate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { deliveryOffer, validateDeliveryOffer } = require('../src/delivery');

const FIXTURES = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.delivery-offer');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }

run([
    ['deliveryOffer passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('delivery-offer fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', f), 'utf8'));
            assert.deepEqual(deliveryOffer({ ...fixture }), fixture, f);
            assert.deepEqual(validateDeliveryOffer(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['deliveryOffer strips null/undefined', async () => {
        const o = deliveryOffer({ id: 'd1', transports: ['http'], regions: ['us-west'], edge: true,
            price_per_gb_usd: 0.02, price_per_request_usd: 0.00001,
            cache_rules: { enabled: true }, node: null });
        assert.ok(!('node' in o), 'null node stripped');
    }],
    ['validateDeliveryOffer refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('delivery-offer invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid', f), 'utf8'));
            const r = validateDeliveryOffer(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
]);
