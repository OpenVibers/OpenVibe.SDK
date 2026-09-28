'use strict';
/** openvibe-sdk/govern: quotas by tier and window, reserve/commit/release, idempotent charges, concurrency leases; in memory and on Valkey. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const { createGovernor } = require('../src/govern');
const { createValkey } = require('../src/valkey');

const policy = { 'browser-second': { anonymous: { day: 0 }, user: { minute: 100, day: 600 } }, 'job-run': { user: { hour: 3 } } };
const quiet = { log() {}, warn() {}, error() {} };

function suite(label, make) {
    return [
        [`${label}: a reservation counts against every window; over the limit is refused with a retry time`, async () => {
            const gov = await make();
            const a = await gov.reserve({ subject: 'user:u1', unit: 'browser-second', amount: 60, key: 'run-1:step-1' });
            assert.equal(a.ok, true);
            const b = await gov.reserve({ subject: 'user:u1', unit: 'browser-second', amount: 50, key: 'run-1:step-2' });
            assert.equal(b.ok, false);
            assert.equal(b.window, 'minute');
            assert.equal(b.limit, 100);
            assert.ok(b.retryAfterS >= 1 && b.retryAfterS <= 60);
            const u = await gov.usage({ subject: 'user:u1', unit: 'browser-second' });
            assert.equal(u.minute.used, 60);
            assert.equal(u.day.limit, 600);
        }],
        [`${label}: commit moves the counters to the real amount; release gives everything back`, async () => {
            const gov = await make();
            const a = await gov.reserve({ subject: 'user:u2', unit: 'browser-second', amount: 90, key: 'run-2:step-1' });
            await gov.commit(a.id, 30);
            assert.equal((await gov.usage({ subject: 'user:u2', unit: 'browser-second' })).minute.used, 30);
            const b = await gov.reserve({ subject: 'user:u2', unit: 'browser-second', amount: 70, key: 'run-2:step-2' });
            assert.equal(b.ok, true);
            await gov.release(b.id);
            assert.equal((await gov.usage({ subject: 'user:u2', unit: 'browser-second' })).minute.used, 30);
            assert.equal(await gov.release(b.id), false, 'settling twice changes nothing');
        }],
        [`${label}: the same idempotency key charges once`, async () => {
            const gov = await make();
            const a = await gov.reserve({ subject: 'user:u3', unit: 'job-run', amount: 1, key: 'job_01J-retry' });
            const again = await gov.reserve({ subject: 'user:u3', unit: 'job-run', amount: 1, key: 'job_01J-retry' });
            assert.equal(again.replay, true);
            assert.equal(again.id, a.id);
            assert.equal((await gov.usage({ subject: 'user:u3', unit: 'job-run' })).hour.used, 1);
        }],
        [`${label}: a zero limit refuses (anonymous browser time); a missing tier is unlimited`, async () => {
            const gov = await make();
            assert.equal((await gov.reserve({ subject: 'ip:1', tier: 'anonymous', unit: 'browser-second', amount: 1, key: 'anon-try-1' })).ok, false);
            assert.equal((await gov.reserve({ subject: 'user:u4', tier: 'vip', unit: 'browser-second', amount: 1e6, key: 'vip-run-1' })).ok, true);
            await assert.rejects(() => gov.reserve({ subject: 'user:u4', unit: 'coins', amount: 1, key: 'abcdefgh' }), /unknown unit/);
            await assert.rejects(() => gov.reserve({ subject: 'user:u4', unit: 'job-run', amount: 1, key: 'k' }), /idempotency key/);
        }],
        [`${label}: concurrency leases cap parallel work and free a slot on release`, async () => {
            const gov = await make();
            const a = await gov.lease({ subject: 'user:u5', kind: 'browser', max: 2 });
            const b = await gov.lease({ subject: 'user:u5', kind: 'browser', max: 2 });
            const c = await gov.lease({ subject: 'user:u5', kind: 'browser', max: 2 });
            assert.deepEqual([a.ok, b.ok, c.ok], [true, true, false]);
            await a.release();
            assert.equal((await gov.lease({ subject: 'user:u5', kind: 'browser', max: 2 })).ok, true);
        }],
    ];
}

const tests = suite('memory', async () => createGovernor({ policy, now: () => Date.parse('2026-09-28T12:00:30Z') }));
const URL = process.env.OV_TEST_VALKEY_URL;
if (!URL) console.log('govern on valkey: skipped (OV_TEST_VALKEY_URL not set; scripts/test-services.sh up)');
else {
    const opened = [];
    tests.push(...suite('valkey', async () => {
        const v = createValkey({ url: URL, prefix: `ovsdk:gov:${crypto.randomBytes(3).toString('hex')}:`, log: quiet });
        opened.push(v);
        return createGovernor({ policy, valkey: v, now: () => Date.parse('2026-09-28T12:00:30Z') });
    }));
    tests.push(['valkey: close', async () => { for (const v of opened) await v.close(); }]);
}
run(tests);
