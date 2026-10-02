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

let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the usage-record case skips */ }

const usageTests = [
    ['usage record: onUsage gets a platform.usage-sample@1 reading with the service, defaults and per-call overrides, and no money fields', async () => {
        const seen = [];
        const gov = createGovernor({ policy, service: 'openvibe.ai', provider: 'local', region: 'eu-1', resource: 'pool-a', log: quiet,
            now: () => Date.parse('2026-09-28T12:00:30Z'), onUsage: (r) => seen.push(r) });
        const project = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
        await gov.reserve({ subject: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', unit: 'browser-second', amount: 12, key: 'usage-1:step-1', project, operation: 'render' });
        await gov.reserve({ subject: 'user:u1', unit: 'job-run', amount: 1, key: 'usage-2:step-1', provider: 'ovh', resource: 'pool-b', region: 'us-1', trace_id: 'tr-42', route_epoch: 3 });
        await gov.reserve({ subject: 'user:u1', unit: 'job-run', amount: 1, key: 'usage-2:step-1', provider: 'ovh' }); // a replay emits nothing
        assert.equal(seen.length, 2);
        const [a, b] = seen;
        assert.equal(a.service, 'openvibe.ai');
        assert.equal(a.project, project);
        assert.equal(a.operation, 'render');
        assert.equal(a.quantity, 12);
        assert.equal(a.provider, 'local');
        assert.equal(a.region, 'eu-1');
        assert.equal(a.resource, 'pool-a');
        assert.equal(a.at, '2026-09-28T12:00:30.000Z');
        assert.equal(a.idempotency_key, 'usage-1:step-1');
        assert.equal(b.provider, 'ovh'); assert.equal(b.resource, 'pool-b'); assert.equal(b.region, 'us-1');
        assert.equal(b.trace_id, 'tr-42'); assert.equal(b.route_epoch, 3);
        assert.ok(!('project' in b), 'an absent project is left out, not null');
        for (const r of seen) for (const k of ['vibes_charged', 'free_allowance_used', 'cost_estimate', 'amount', 'state']) assert.ok(!(k in r), k);
        if (!contracts) { console.log('govern usage record: skipped validation (openvibe-contracts not installed: npm install)'); return; }
        for (const r of seen) assert.deepEqual(contracts.validate('platform.usage-sample@1', r).errors, []);
    }],
    ['usage record: a governor without service still works and warns once at creation', async () => {
        const warned = [];
        const seen = [];
        const gov = createGovernor({ policy, log: { warn: (m) => warned.push(m) }, onUsage: (r) => seen.push(r) });
        assert.equal(warned.length, 1);
        assert.match(warned[0], /service/);
        assert.equal((await gov.reserve({ subject: 'user:u1', unit: 'job-run', amount: 1, key: 'no-service-1' })).ok, true);
        assert.equal(seen.length, 1);
        assert.ok(!('service' in seen[0]));
        assert.equal(warned.length, 1);
    }],
];

const tests = suite('memory', async () => createGovernor({ policy, service: 'openvibe.test', now: () => Date.parse('2026-09-28T12:00:30Z') }));
const URL = process.env.OV_TEST_VALKEY_URL;
if (!URL) console.log('govern on valkey: skipped (OV_TEST_VALKEY_URL not set; scripts/test-services.sh up)');
else {
    const opened = [];
    tests.push(...suite('valkey', async () => {
        const v = createValkey({ url: URL, prefix: `ovsdk:gov:${crypto.randomBytes(3).toString('hex')}:`, log: quiet });
        opened.push(v);
        return createGovernor({ policy, service: 'openvibe.test', valkey: v, now: () => Date.parse('2026-09-28T12:00:30Z') });
    }));
    tests.push(['valkey: close', async () => { for (const v of opened) await v.close(); }]);
}
tests.push(...usageTests);
run(tests);
