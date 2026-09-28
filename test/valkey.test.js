'use strict';
/**
 * valkey, cache, limits store, queue, pubsub (ADR-035): the in-process versions always; against Valkey 9 when
 * OV_TEST_VALKEY_URL is set (scripts/test-services.sh up). With Valkey: getOrSet loads once across two
 * connections, tags invalidate, two limiters share one count and fall back to their own when Valkey fails, the
 * queue retries with backoff, dead-letters, delays, dedupes and reclaims a job a hung worker holds, pub/sub
 * crosses connections, and every key stays inside the service prefix.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep } = require('./helpers');
const { createValkey } = require('../src/valkey');
const { createCache } = require('../src/cache');
const { createQueue } = require('../src/queue');
const { createPubSub } = require('../src/pubsub');
const { createActorLimiter, createValkeyLimitStore } = require('../src/limits');

const quiet = { log() {}, warn() {}, error() {} };
function call(mw, req) {
    return new Promise((resolve) => {
        const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end: (body) => resolve({ status: res.statusCode, retry: res.headers['retry-after'], body }) };
        mw(req, res, () => resolve({ status: 200 }));
    });
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };

const tests = [
    ['memory cache: single-flight, TTL, tags', async () => {
        const cache = createCache({ namespace: 'm', ttlSec: 60, log: quiet });
        let loads = 0;
        const vals = await Promise.all(Array.from({ length: 10 }, () => cache.getOrSet('k', 60, async () => { loads++; await sleep(20); return { v: 1 }; })));
        assert.equal(loads, 1);
        assert.deepEqual(vals[9], { v: 1 });
        await cache.set('t1', 'a', 60, { tags: ['space:1'] }); await cache.set('t2', 'b', 60, { tags: ['space:1'] });
        assert.equal(await cache.invalidateTag('space:1'), 2);
        assert.equal(await cache.get('t1'), undefined);
        assert.equal(cache.stats().store, 'memory');
    }],
    ['memory queue: runs, retries, dead-letters, dedupes', async () => {
        const q = createQueue({ name: 'jobs' });
        const seen = []; let flaky = 0;
        const w = q.process(async (d) => {
            if (d.kind === 'flaky' && flaky++ < 1) throw new Error('once');
            if (d.kind === 'bad') throw new Error('always');
            seen.push(d.n);
        }, { concurrency: 2, backoffMs: () => 5 });
        await q.add({ n: 1 }); await q.add({ n: 2 }); await q.add({ kind: 'flaky', n: 3 });
        await q.add({ kind: 'bad' }, { attempts: 2 });
        assert.equal(await q.add({ n: 9 }, { id: 'same' }) !== null, true);
        assert.equal(await q.add({ n: 9 }, { id: 'same' }), null, 'deduped');
        assert.ok(await until(async () => seen.length === 4 && (await q.stats()).dead === 1));
        assert.deepEqual(seen.sort(), [1, 2, 3, 9]);
        assert.equal((await q.dead())[0].error, 'always');
        await w.stop();
    }],
    ['memory pubsub', async () => {
        const ps = createPubSub();
        const got = [];
        const off = await ps.subscribe('room:1', (m) => got.push(m));
        await ps.publish('room:1', { t: 'hi' });
        await off();
        await ps.publish('room:1', { t: 'gone' });
        assert.deepEqual(got, [{ t: 'hi' }]);
    }],
];

const URL = process.env.OV_TEST_VALKEY_URL;
if (!URL) console.log('valkey integration: skipped (OV_TEST_VALKEY_URL not set; scripts/test-services.sh up)');
else {
    const prefix = `ovsdk:test:${crypto.randomBytes(3).toString('hex')}:`;
    const open = () => createValkey({ url: URL, prefix, log: quiet });
    tests.push(
        ['valkey: ready, cache single-flight across connections, tags', async () => {
            const a = open(); const b = open();
            try {
                await a.client.flushdb();
                assert.equal((await a.ready()).ok, true);
                const ca = createCache({ valkey: a, namespace: 'pages', log: quiet }); const cb = createCache({ valkey: b, namespace: 'pages', log: quiet });
                let loads = 0;
                const loader = async () => { loads++; await sleep(150); return { title: 'A' }; };
                const [x, y] = await Promise.all([ca.getOrSet('slug:a', 60, loader), cb.getOrSet('slug:a', 60, loader)]);
                assert.deepEqual([x, y], [{ title: 'A' }, { title: 'A' }]);
                assert.equal(loads, 1, 'the second process waited for the first one\'s value');
                await ca.set('p1', 1, 60, { tags: ['space:7'] });
                assert.equal(await cb.invalidateTag('space:7'), 1);
                assert.equal(await ca.get('p1'), undefined);
            } finally { await a.close(); await b.close(); }
        }],
        ['valkey: two limiters share one count; a failing store falls back', async () => {
            const a = open(); const b = open();
            try {
                let t = 1_000_000_020_000;
                const la = createActorLimiter({ limits: { minute: 3 }, now: () => t, store: createValkeyLimitStore(a), log: quiet });
                const lb = createActorLimiter({ limits: { minute: 3 }, now: () => t, store: createValkeyLimitStore(b), log: quiet });
                const req = { user: { subject_id: 'usr_x' } };
                const out = [];
                for (const lim of [la, lb, la, lb]) out.push((await call(lim('wiki.page.write'), req)).status);
                assert.deepEqual(out, [200, 200, 200, 429], 'three per minute across both processes');
                t += 60_000;
                assert.equal((await call(lb('wiki.page.write'), req)).status, 200, 'the next window reopens');
                // Valkey gone: the limiter keeps counting in its own process.
                const dead = createValkey({ url: 'redis://127.0.0.1:1/0', prefix, log: quiet });
                dead.client.options.maxRetriesPerRequest = 0; dead.client.options.enableOfflineQueue = false;
                const lf = createActorLimiter({ limits: { minute: 1 }, now: () => t, store: createValkeyLimitStore(dead), log: quiet });
                assert.equal((await call(lf('x'), req)).status, 200);
                assert.equal((await call(lf('x'), req)).status, 429, 'counted locally while the store fails');
                dead.client.disconnect();
            } finally { await a.close(); await b.close(); }
        }],
        ['valkey queue: processes, retries with backoff, dead-letters, delays, dedupes', async () => {
            const v = open();
            try {
                const q = createQueue({ valkey: v, name: 'thumbs', log: quiet });
                const done = []; let flaky = 0;
                const w = q.process(async (d) => {
                    if (d.kind === 'flaky' && flaky++ < 1) throw new Error('once');
                    if (d.kind === 'bad') throw new Error('always');
                    done.push(d.n);
                }, { concurrency: 3, blockMs: 200 });
                await q.add({ n: 1 }); await q.add({ n: 2 }); await q.add({ kind: 'flaky', n: 3 });
                await q.add({ kind: 'bad', n: 4 }, { attempts: 2 });
                await q.add({ n: 5 }, { delayMs: 300 });
                assert.notEqual(await q.add({ n: 6 }, { id: 'thumb:6' }), null);
                assert.equal(await q.add({ n: 6 }, { id: 'thumb:6' }), null, 'deduped');
                assert.ok(await until(async () => done.length === 5 && (await q.stats()).dead === 1, 8000), `done ${done}`);
                assert.deepEqual(done.sort(), [1, 2, 3, 5, 6]);
                const [d] = await q.dead();
                assert.deepEqual([d.data, d.attempts, d.error], [{ kind: 'bad', n: 4 }, 2, 'always']);
                const st = await q.stats();
                assert.deepEqual([st.waiting, st.pending, st.delayed], [0, 0, 0]);
                await w.stop();
            } finally { await v.close(); }
        }],
        ['valkey queue: a job a hung worker holds is reclaimed after the visibility timeout', async () => {
            const v1 = open(); const v2 = open();
            try {
                const q1 = createQueue({ valkey: v1, name: 'reclaim', log: quiet });
                const q2 = createQueue({ valkey: v2, name: 'reclaim', log: quiet });
                let took = false;
                const hung = q1.process(async () => { took = true; await new Promise(() => {}); }, { concurrency: 1, blockMs: 200, visibilityMs: 60000 });
                await q1.add({ n: 'x' });
                assert.ok(await until(async () => took));
                const got = [];
                const rescuer = q2.process(async (d, job) => { got.push([d.n, job.attempt]); }, { concurrency: 1, blockMs: 200, visibilityMs: 600 });
                assert.ok(await until(async () => got.length === 1, 6000), 'reclaimed');
                assert.deepEqual(got[0], ['x', 1]);
                await rescuer.stop(); await hung.stop(100);
            } finally { await v1.close(); await v2.close(); }
        }],
        ['valkey pubsub across connections; every key stays inside the prefix', async () => {
            const a = open(); const b = open();
            try {
                const pa = createPubSub({ valkey: a, log: quiet }); const pb = createPubSub({ valkey: b, log: quiet });
                const got = [];
                const off = await pb.subscribe('room:1', (m) => got.push(m));
                assert.ok(await until(async () => (await pa.publish('room:1', { t: 'hi' })) === 1));
                assert.ok(await until(async () => got.length >= 1));
                assert.deepEqual(got[0], { t: 'hi' });
                await off(); await pb.close();
                const keys = await a.client.keys('*');
                assert.ok(keys.length > 0);
                assert.deepEqual(keys.filter((k) => !k.startsWith(prefix)), [], 'no key outside the prefix');
            } finally { await a.close(); await b.close(); }
        }],
    );
}

run(tests).then(() => process.exit(0));
