'use strict';
/** openvibe-sdk/storage: platform.storage-offer@1 — build and validate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { storageOffer, validateStorageOffer } = require('../src/storage');

const FIXTURES = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.storage-offer');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }

run([
    ['storageOffer passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('storage-offer fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', f), 'utf8'));
            assert.deepEqual(storageOffer({ ...fixture }), fixture, f);
            assert.deepEqual(validateStorageOffer(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['storageOffer strips null/undefined', async () => {
        const o = storageOffer({ id: 's1', class: 'warm', capacity_gb: 1000, price_per_gb_month_usd: 0.02,
            price_per_operation_usd: 0.00001, region: 'us-west', node: 'n1',
            durability: { replicas: 3 }, lifecycle_rules: null });
        assert.ok(!('lifecycle_rules' in o), 'null lifecycle_rules stripped');
    }],
    ['validateStorageOffer refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('storage-offer invalid fixtures: skipped (openvibe-contracts not installed: npm install)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid', f), 'utf8'));
            const r = validateStorageOffer(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
]);
