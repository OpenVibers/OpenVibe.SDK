'use strict';

const assert = require('assert');
const { AGE_BANDS, atLeast, createTrustClient, isNew } = require('../src/trust');

const guest = { kind: 'guest', age_band: 'under_1d', age_hours: 8, age_days: 0, networks_seen: 1, guests_from_same_networks_24h: 0, converted: false };
const account = { kind: 'account', age_band: '30d_plus', account_age_hours: 960, account_age_days: 40, passkey: false, linked_accounts: 0, active_30d: true, email_verified: false, verified: true, verified_by: ['30_days_active'] };

assert.deepStrictEqual(AGE_BANDS, ['under_1h', 'under_1d', 'under_7d', 'under_30d', '30d_plus']);
assert.strictEqual(isNew(guest, { hours: 24 }), true);
assert.strictEqual(isNew(account, { hours: 24 }), false);
assert.strictEqual(atLeast(guest, 'under_7d'), false);
assert.strictEqual(atLeast(account, 'under_7d'), true);
assert.strictEqual(atLeast(guest, 'unknown'), false);
assert.throws(() => isNew(guest, { hours: -1 }), TypeError);

(async () => {
    const calls = [];
    const client = createTrustClient({
        networkUrl: 'https://network.example/',
        getToken: async () => 'personal-token',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 200, json: async () => guest };
        },
    });
    assert.deepStrictEqual(await client.me(), guest);
    assert.deepStrictEqual(await client.of('gst_01JAB2C3D4E5F6G7H8J9K0MNP1'), guest);
    assert.strictEqual(calls[0].url, 'https://network.example/api/v1/me/trust');
    assert.strictEqual(calls[1].url, 'https://network.example/api/v1/trust/gst_01JAB2C3D4E5F6G7H8J9K0MNP1');
    assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer personal-token');
    assert.throws(() => client.of('invalid'), TypeError);
    console.log('trust: helper and client checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
