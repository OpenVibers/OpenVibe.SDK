'use strict';
/** openvibe-sdk/placement: constraints before cost, marginal cost after free allowances, hysteresis, rendezvous, P2C, signed plans. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const { plan, marginalCost, rendezvous, pickTwo, signPlan, verifyPlan, createPlanHolder, ownedLoadCost } = require('../src/placement');

const T = Date.parse('2026-09-16T00:00:00Z');   // half of September gone
const period = { period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z' };
const node = (id, util, extra = {}) => ({ offer_id: id, kind: 'node', region: 'us-west', trust: 'first-party', capabilities: ['worker:browser'], capacity: { cpu: { utilization: util, available_cores: 4 }, memory: { available_mb: 8000 } }, latency_ms: { start_p95: 40 }, health: { status: 'up' }, pricing: { model: 'prepaid' }, updated_at: '2026-09-15T00:00:00Z', ...extra });
const provider = (id, card, extra = {}) => ({ offer_id: id, kind: 'provider', provider: id, region: 'global', trust: 'external', capabilities: ['worker:browser'], latency_ms: { start_p95: 120 }, health: { status: 'up' }, pricing: { model: 'per-operation', rate_card: card }, updated_at: '2026-09-15T00:00:00Z', ...extra });
const card = (id, provider, free, price, size = 1e6) => ({ id, provider, metric: 'op', unit_size: size, unit_price_usd: price, free_allowance: free, reset_period: 'month', effective_from: '2026-09-01', source: 'https://example.com', verified_at: '2026-09-28' });
const req = (o = {}) => ({ kind: 'watch.browser', mobility: 'job', latency_class: 'background', objective: 'cheapest', capabilities: ['worker:browser'], ...o });

run([
    ['a free allowance that will run out before the period ends is priced as paid', async () => {
        const c = card('rc', 'p', 1e6, 0.4);
        // Half the month gone, 430k used: the forecast is 860k, so 100k more stay free.
        assert.equal(marginalCost(c, { provider: 'p', ...period, usage: { op: 430000 } }, 100000, { now: T }), 0);
        // 600k used by mid-month: forecast 1.2M, past the allowance; the next million is billed.
        assert.ok(marginalCost(c, { provider: 'p', ...period, usage: { op: 600000 } }, 1e6, { now: T }) > 0);
        // A 20% reserve for higher-priority work makes normal work pay sooner, never high-priority work.
        const s = { provider: 'p', ...period, usage: { op: 430000 }, reserve: { op: 0.2 } };
        assert.ok(marginalCost(c, s, 100000, { now: T }) > 0);
        assert.equal(marginalCost(c, s, 100000, { now: T, priority: 'high' }), 0);
    }],
    ['owned capacity is ~free until its binding resource is busy, then work spills elsewhere', async () => {
        assert.equal(ownedLoadCost(node('a', 0.3)), 0);
        assert.ok(ownedLoadCost(node('a', 0.8)) > 0);
        const cards = [card('rc_q', 'q', 1e6, 0.4)];
        const states = [{ provider: 'q', ...period, usage: { op: 1000 } }];
        assert.equal(plan(req(), [node('own', 0.3), provider('q', 'rc_q')], { rateCards: cards, states, now: T }).selected, 'own');
        assert.equal(plan(req(), [node('own', 0.95), provider('q', 'rc_q')], { rateCards: cards, states, now: T }).selected, 'q');
    }],
    ['hard constraints exclude a cheaper candidate, with the reason', async () => {
        const r = plan(req({ objective: 'balanced', trust: ['first-party'], max_latency_ms: 100 }), [node('own', 0.2), provider('cheap', 'rc'), node('slow', 0.1, { offer_id: 'slow', latency_ms: { start_p95: 400 } })], { rateCards: [card('rc', 'cheap', 1e9, 0)], now: T });
        assert.equal(r.selected, 'own');
        assert.match(r.candidates.find((c) => c.id === 'cheap').excluded_because, /first-party/);
        assert.match(r.candidates.find((c) => c.id === 'slow').excluded_because, /over 100 ms/);
        assert.equal(plan(req({ objective: 'private' }), [provider('ext', 'rc')], { rateCards: [card('rc', 'ext', 1e9, 0)], now: T }).selected, null, 'private work never leaves first-party capacity');
        assert.match(plan(req(), [node('down', 0.1, { health: { status: 'down' } })], { now: T }).candidates[0].excluded_because, /health down/);
    }],
    ['an unpriced paid provider is never assumed free', async () => {
        const r = plan(req(), [provider('mystery', 'rc_missing')], { now: T });
        assert.equal(r.selected, null);
    }],
    ['hysteresis: stay unless clearly better; fail over at once when the current one drops out', async () => {
        const a = node('a', 0.3, { latency_ms: { start_p95: 50 } }); const b = node('b', 0.3, { latency_ms: { start_p95: 46 } });
        const r = plan(req({ objective: 'lowest-latency' }), [a, b], { current: 'a', now: T });
        assert.equal(r.selected, 'a');
        assert.match(r.reasons[0], /only .*% better/);
        const moved = plan(req({ objective: 'lowest-latency' }), [{ ...a, health: { status: 'down' } }, b], { current: 'a', now: T });
        assert.equal(moved.selected, 'b');
        assert.ok(moved.reasons.some((x) => /no longer eligible/.test(x)));
    }],
    ['critical work stays with its authority whatever the cost', async () => {
        const r = plan(req({ latency_class: 'critical', objective: 'correctness', authority: 'ledger' }), [node('ledger', 0.95), node('idle', 0.1)], { now: T });
        assert.equal(r.selected, 'ledger');
    }],
    ['rendezvous hashing is stable and moves little when a target is added', async () => {
        const t3 = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
        const keys = Array.from({ length: 2000 }, (_, i) => `room:${i}`);
        const before = keys.map((k) => rendezvous(k, t3).id);
        assert.deepEqual(keys.map((k) => rendezvous(k, t3).id), before);
        const after = keys.map((k) => rendezvous(k, [...t3, { id: 'd', weight: 1 }]).id);
        const moved = after.filter((x, i) => x !== before[i]);
        assert.ok(moved.every((x) => x === 'd'), 'only keys that now belong to the new target move');
        assert.ok(moved.length > 300 && moved.length < 700, `about a quarter move (${moved.length})`);
        const heavy = keys.map((k) => rendezvous(k, [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }]).id).filter((x) => x === 'a').length;
        assert.ok(heavy > 1300 && heavy < 1700, `weights hold (${heavy}/2000)`);
    }],
    ['power of two choices picks the less loaded of two', async () => {
        const load = { a: 400, b: 120, c: 80 };
        let r = 0; const seq = [0.1, 0.9];   // picks index 0 and then 2
        assert.equal(pickTwo(['a', 'b', 'c'], (x) => load[x], () => seq[r++]), 'c');
    }],
    ['signed route plans: verified, refused when tampered, expired or older; the last good plan stays', async () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const body = { epoch: 2, issued_at: '2026-09-28T00:00:00Z', expires_at: '2026-09-29T00:00:00Z', issuer: 'network', key_id: 'k1', routes: [{ route: 'events:background', targets: [{ id: 'valkey', weight: 1 }] }] };
        const p = signPlan(body, privateKey);
        const now = Date.parse('2026-09-28T12:00:00Z');
        assert.equal(verifyPlan(p, { k1: publicKey }, { now }).ok, true);
        assert.equal(verifyPlan({ ...p, routes: [] }, { k1: publicKey }, { now }).reason, 'bad signature');
        assert.equal(verifyPlan(p, { k1: publicKey }, { now: Date.parse('2026-09-30T00:00:00Z') }).reason, 'expired');
        assert.equal(verifyPlan(p, { other: publicKey }, { now }).reason, 'unknown key k1');
        const holder = createPlanHolder({ k1: publicKey }, { now: () => now });
        assert.equal(holder.accept(p), true);
        assert.equal(holder.accept(signPlan({ ...body, epoch: 1 }, privateKey)), false, 'an older epoch is ignored');
        assert.equal(holder.accept({ ...p, epoch: 3 }), false, 'a tampered plan is ignored');
        assert.deepEqual(holder.targets('events:background'), [{ id: 'valkey', weight: 1 }]);
    }],
]);
