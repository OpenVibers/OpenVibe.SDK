'use strict';
/**
 * openvibe-sdk/placement v1 (agent plan A1): rules, ownership, quality and cost per success, learning, escalation and
 * the line. Fixed numbers: every expectation below is hand-computed in its comment; there is no clock and no I/O.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const {
    place, plan, escalate, optionKey, learn, successOf, lineFor,
    excluded, TRUST_CLASSES, TRUST_ORDER, DEFAULT_TRUST,
} = require('../src/placement');

const T = Date.parse('2026-10-30T12:00:00Z');
const DAY = 86400000;
const ISO = (ms) => new Date(ms).toISOString();
const P = `usr_${'A'.repeat(26)}`;
const Q = `usr_${'B'.repeat(26)}`;

const offer = (id, extra = {}) => ({
    offer_id: id, kind: 'node', provider: 'pool', region: 'us-west', trust: 'first-party',
    capabilities: ['worker:browser'], health: { status: 'up' },
    pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 },
    updated_at: '2026-10-30T00:00:00Z', ...extra,
});
const req = (o = {}) => ({ kind: 'watch.browser', mobility: 'job', latency_class: 'background', objective: 'cheapest', capabilities: ['worker:browser'], ...o });
const ctx = (o = {}) => ({ now: T, rateCards: [], states: [], floor: 0, step: { kind: 'code.fix' }, ...o });
const close = (actual, expected, why) => assert.ok(Math.abs(actual - expected) < 1e-12, `${why}: ${actual} != ${expected}`);

run([
    ['optionKey adds the model, or the harness, when the offer carries one', async () => {
        assert.equal(optionKey({ offer_id: 'app:codes/claude-code', model: 'opus' }), 'app:codes/claude-code@opus');
        assert.equal(optionKey({ offer_id: 'app:codes/claude-code', detail: { model: 'opus' } }), 'app:codes/claude-code@opus');
        assert.equal(optionKey({ offer_id: 'app:codes/claude-code', detail: { harness: 'claude-code' } }), 'app:codes/claude-code@claude-code');
        assert.equal(optionKey({ offer_id: 'node:1', model: 'm', harness: 'h' }), 'node:1@m', 'the model wins over the harness');
        assert.equal(optionKey({ offer_id: 'node:1' }), 'node:1');
    }],

    ['the default trust is the contract\'s four classes: user-owned is never a default', async () => {
        assert.deepEqual([...DEFAULT_TRUST], ['first-party', 'partner', 'community', 'external']);
        assert.deepEqual([...TRUST_CLASSES], ['first-party', 'user-owned', 'partner', 'community', 'external']);
        assert.deepEqual([...TRUST_ORDER], [...TRUST_CLASSES]);
        const own = offer('usr-node', { trust: 'user-owned', owner: P, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        assert.match(excluded(req(), own), /first-party/);
        assert.equal(excluded(req({ trust: ['user-owned'] }), own), null);
        assert.equal(plan(req(), [own, offer('ext')], { now: T }).selected, 'ext', 'a cheaper user-owned offer is not a default');
        assert.equal(plan(req({ trust: ['user-owned'] }), [own, offer('ext')], { now: T }).selected, 'usr-node');
    }],

    ['ownership: a user-owned offer is only ever its owner\'s, even when user-owned is named', async () => {
        const mine = offer('mine', { trust: 'user-owned', owner: P, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0.01 } });
        const theirs = offer('theirs', { trust: 'user-owned', owner: Q, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const r = place(req({ trust: ['user-owned'] }), [mine, theirs], ctx({ person: P }));
        assert.equal(r.result.selected, 'mine');
        assert.deepEqual(r.rejected.find((x) => x.id === 'theirs'), { id: 'theirs', why: "another person's machine" });
        const noPerson = place(req({ trust: ['user-owned'] }), [mine], ctx({ person: undefined }));
        assert.equal(noPerson.result.selected, null);
        assert.equal(noPerson.rejected[0].why, 'a user-owned machine needs its owner');
        const noOwner = place(req({ trust: ['user-owned'] }), [offer('ownerless', { trust: 'user-owned' })], ctx({ person: P }));
        assert.equal(noOwner.rejected[0].why, 'a user-owned machine has no owner');
    }],

    ['rule noCloud: only this person\'s user-owned machine', async () => {
        const cloud = offer('cloud', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0 } });
        const mine = offer('mine', { trust: 'user-owned', owner: P, provider: 'Claude', pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const theirs = offer('theirs', { trust: 'user-owned', owner: Q, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const r = place(req(), [cloud, mine, theirs], ctx({ person: P, rules: { noCloud: true }, names: { mine: 'your desktop' } }));
        assert.equal(r.result.selected, 'mine');
        assert.deepEqual(r.rejected, [
            { id: 'cloud', why: 'your rule: never send my repo to the cloud' },
            { id: 'theirs', why: "another person's machine" },
        ]);
        assert.equal(r.line, 'On your desktop: it has your Claude sign-in and your files, and it\'s free.');
    }],

    ['rule onlyFree: max_cost_usd 0, so paid offers are excluded and free allowances still qualify', async () => {
        const free = offer('free', { pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const paid = offer('paid', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const r = place(req(), [free, paid], ctx({ person: P, rules: { onlyFree: true } }));
        assert.equal(r.result.selected, 'free');
        assert.match(r.rejected.find((x) => x.id === 'paid').why, /over \$0/);
    }],

    ['rule region: residency is hard', async () => {
        const us = offer('us', { region: 'us-west' });
        const eu = offer('eu', { region: 'eu' });
        const r = place(req(), [us, eu], ctx({ person: P, rules: { region: 'eu' } }));
        assert.equal(r.result.selected, 'eu');
        assert.deepEqual(r.rejected.find((x) => x.id === 'us'), { id: 'us', why: 'outside eu' });
    }],

    ['rule uncensored: without it, model:uncensored offers are excluded', async () => {
        const unc = offer('unc', { capabilities: ['worker:browser', 'model:uncensored'], pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const paid = offer('paid', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const off = place(req(), [unc, paid], ctx({ person: P }));
        assert.equal(off.result.selected, 'paid');
        assert.deepEqual(off.rejected.find((x) => x.id === 'unc'), { id: 'unc', why: 'uncensored models are off in your rules' });
        const on = place(req(), [unc, paid], ctx({ person: P, rules: { uncensored: true } }));
        assert.equal(on.result.selected, 'unc');
        assert.equal(on.rejected.length, 0);
    }],

    ['rule maxCostUsd: the lower of the rule and the requirements', async () => {
        const low = offer('low', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.005 } });
        const high = offer('high', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.02 } });
        const r = place(req(), [low, high], ctx({ person: P, rules: { maxCostUsd: 0.01 } }));
        assert.equal(r.result.selected, 'low');
        assert.deepEqual(r.rejected.find((x) => x.id === 'high'), { id: 'high', why: 'estimated $0.020000 over $0.01' });
        const lowerReq = place(req({ max_cost_usd: 0.001 }), [low], ctx({ person: P, rules: { maxCostUsd: 0.01 } }));
        assert.equal(lowerReq.result.selected, null, 'the requirements\' lower ceiling still wins');
    }],

    ['rule prefer: an objective unless the requirements name one', async () => {
        const free = offer('free', { pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const paid = offer('paid', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const r = place(req({ objective: undefined }), [free, paid], ctx({ person: P, rules: { prefer: 'cheapest' } }));
        assert.equal(r.result.objective, 'cheapest');
        const named = place(req({ objective: 'balanced' }), [free, paid], ctx({ person: P, rules: { prefer: 'cheapest' } }));
        assert.equal(named.result.objective, 'balanced');
        const fast = place(req({ objective: undefined }), [free, paid], ctx({ person: P, rules: { prefer: 'fastest' } }));
        assert.equal(fast.result.objective, 'lowest-latency');
    }],

    ['successOf: the Beta mean, hand-computed (no counts, a Bench prior, personal vs global)', async () => {
        // No counts and no Bench prior: (2·0.7 + 0) / (2 + 0) = 0.7.
        close(successOf([], { person: P, key: 'k', kind: 'code.fix', now: T }), 0.7, 'no counts');
        // A Bench prior 0.8: (4·0.8) / 4 = 0.8.
        close(successOf([], { person: P, key: 'k', kind: 'code.fix', prior: 0.8, now: T }), 0.8, 'prior only');
        // This person 9/10 (okP=9, nP=10), everyone 10/20 (okG=10, nG=20, w=1):
        // (2·0.7 + 9 + 1·10) / (2 + 10 + 1·20) = 20.4 / 32 = 0.6375.
        const counts = [
            { person: P, key: 'k', kind: 'code.fix', ok_w: 9, n_w: 10, updated_at: ISO(T) },
            { person: Q, key: 'k', kind: 'code.fix', ok_w: 1, n_w: 10, updated_at: ISO(T) },
        ];
        close(successOf(counts, { person: P, key: 'k', kind: 'code.fix', now: T }), 0.6375, 'personal counts');
        // Without this person's rows: (2·0.7 + 10) / (2 + 20) = 11.4 / 22 = 0.51818…, so the personal record wins.
        close(successOf(counts, { person: `usr_${'C'.repeat(26)}`, key: 'k', kind: 'code.fix', now: T }), 11.4 / 22, 'global only');
    }],

    ['successOf: decay at 14 and 28 days', async () => {
        // 4/8 written 28 days ago. At 14 days ago it has decayed by half: 2/4, w=1.
        // (2·0.7 + 2 + 2) / (2 + 4 + 4) = 5.4 / 10 = 0.54.
        const old = [{ person: P, key: 'k', kind: 'code.fix', ok_w: 4, n_w: 8, updated_at: ISO(T - 28 * DAY) }];
        close(successOf(old, { person: P, key: 'k', kind: 'code.fix', now: T - 14 * DAY }), 0.54, '14 days');
        // At now it has decayed by a quarter: 1/2.
        // (2·0.7 + 1 + 1) / (2 + 2 + 2) = 3.4 / 6 = 0.56666….
        close(successOf(old, { person: P, key: 'k', kind: 'code.fix', now: T }), 3.4 / 6, '28 days');
    }],

    ['successOf: the kind falls back by dotted prefix, then to every kind', async () => {
        // No code.fix counts, so the code counts 6/8 are used. w=1:
        // (2·0.7 + 6 + 6) / (2 + 8 + 8) = 13.4 / 18 = 0.74444….
        const parent = [{ person: P, key: 'k', kind: 'code', ok_w: 6, n_w: 8, updated_at: ISO(T) }];
        close(successOf(parent, { person: P, key: 'k', kind: 'code.fix', now: T }), 13.4 / 18, 'code prefix');
        close(successOf(parent, { person: P, key: 'k', kind: 'code.fix.tests', now: T }), 13.4 / 18, 'two levels up');
        // No code.fix and no code: the key's counts over every kind are used.
        const other = [{ person: P, key: 'k', kind: 'other.kind', ok_w: 6, n_w: 8, updated_at: ISO(T) }];
        close(successOf(other, { person: P, key: 'k', kind: 'code.fix', now: T }), 13.4 / 18, 'all kinds');
    }],

    ['learn: decays to the write time, adds the try, and never mutates its input', async () => {
        const before = [{ person: P, key: 'k', kind: 'code.fix', ok_w: 2, n_w: 4, updated_at: ISO(T - 14 * DAY) }];
        const copy = JSON.parse(JSON.stringify(before));
        const after = learn(before, { person: P, key: 'k', kind: 'code.fix', ok: true, at: T });
        assert.deepEqual(before, copy, 'the input is untouched');
        assert.notEqual(after, before);
        // 2/4 at 14 days decays to 1/2; one success makes 2/3.
        assert.equal(after[0].ok_w, 2);
        assert.equal(after[0].n_w, 3);
        assert.equal(after[0].updated_at, ISO(T));
        const fresh = learn([], { person: P, key: 'k', kind: 'code.fix', ok: false, at: T });
        assert.deepEqual(fresh, [{ person: P, key: 'k', kind: 'code.fix', ok_w: 0, n_w: 1, updated_at: ISO(T) }]);
    }],

    ['plan: cost per success changes the ranking; raw cost in the result does not', async () => {
        const cheap = offer('cheap', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const dear = offer('dear', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.02 } });
        assert.equal(plan(req(), [cheap, dear], { now: T }).selected, 'cheap', 'without success, the cheap option wins');
        // Per success: cheap 0.01/0.40 = 0.025; dear 0.02/0.95 = 0.0210526…, so dear wins.
        const withSuccess = plan(req(), [cheap, dear], { now: T, success: { cheap: 0.4, dear: 0.95 } });
        assert.equal(withSuccess.selected, 'dear');
        assert.equal(withSuccess.candidates.find((c) => c.id === 'dear').estimated_cost_usd, 0.02, 'the result keeps the raw cost');
        assert.equal(plan(req(), [cheap, dear], { now: T, success: {} }).selected, 'cheap', 'an empty map is no change');
        const r = place(req(), [cheap, dear], ctx({ person: P, floor: 0.3, priors: { cheap: 0.4, dear: 0.95 } }));
        assert.equal(r.result.selected, 'dear');
        assert.deepEqual(r.ranked.map((x) => x.id), ['dear', 'cheap']);
        close(r.ranked.find((x) => x.id === 'cheap').cost_per_success_usd, 0.025, 'cheap per success');
        close(r.ranked.find((x) => x.id === 'dear').cost_per_success_usd, 0.02 / 0.95, 'dear per success');
    }],

    ['the floor and the fallback', async () => {
        const good = offer('good');
        const bad = offer('bad');
        const r = place(req({ trust: ['first-party'] }), [good, bad], ctx({ person: P, floor: 0.5, priors: { good: 0.55, bad: 0.4 } }));
        assert.equal(r.result.selected, 'good');
        assert.deepEqual(r.rejected, [{ id: 'bad', why: 'below the bar for code.fix (40% < 50%)' }]);
        assert.equal(r.fallback, null);
        const none = place(req({ trust: ['first-party'] }), [good, bad], ctx({ person: P, floor: 0.8, priors: { good: 0.4, bad: 0.3 }, names: { good: 'MiniMax M2' } }));
        assert.equal(none.result.selected, null);
        assert.deepEqual(none.fallback, { id: 'good', success: 0.4 });
        assert.equal(none.line, 'Nothing meets the bar for code.fix; the best is MiniMax M2 at 40%. Ask before going ahead?');
    }],

    ['the line: owned and free', async () => {
        const own = offer('desk', { trust: 'user-owned', owner: P, provider: 'Claude', region: 'home', pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const r = place(req({ trust: ['user-owned'] }), [own], ctx({ person: P, floor: 0.5, priors: { desk: 0.9 }, names: { desk: 'your desktop' } }));
        assert.equal(r.line, 'On your desktop: it has your Claude sign-in and your files, and it\'s free.');
    }],

    ['the line: a streaming machine, and the step needs 4 cores', async () => {
        const desk = offer('desk', { trust: 'user-owned', owner: P, provider: 'Claude', region: 'home', health: { status: 'up', streaming: true }, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const pool = offer('pool', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.003 } });
        const r = place(req({ resources: { cpu: 4 } }), [desk, pool], ctx({
            person: P, current: 'desk', floor: 0.5, priors: { desk: 0.9, pool: 0.91 }, names: { desk: 'your desktop', pool: 'the cloud pool' },
        }));
        assert.equal(r.result.selected, 'pool');
        assert.deepEqual(r.rejected, [{ id: 'desk', why: 'it is streaming' }]);
        assert.equal(r.line, 'On the cloud pool: your desktop is streaming, and this needs 4 cores.');
    }],

    ['the line: the cheapest that meets the bar', async () => {
        const cheap = offer('cheap', { provider: 'deepseek', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.003 } });
        const dear = offer('dear', { provider: 'other', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const r = place(req(), [cheap, dear], ctx({ person: P, floor: 0.5, priors: { cheap: 0.91, dear: 0.8 }, names: { cheap: 'DeepSeek V4 Flash' } }));
        assert.equal(r.result.selected, 'cheap');
        assert.equal(r.line, 'On DeepSeek V4 Flash: the cheapest that meets the bar ($0.003 a try, 91% expected).');
    }],

    ['the line: staying on the current one', async () => {
        const lap = offer('lap', { latency_ms: { start_p95: 50 } });
        const alt = offer('alt', { latency_ms: { start_p95: 47 } });
        const r = place(req({ objective: 'lowest-latency' }), [lap, alt], ctx({ person: P, current: 'lap', floor: 0.5, names: { lap: 'your laptop' } }));
        assert.equal(r.result.selected, 'lap');
        assert.equal(r.line, 'Staying on your laptop: the best alternative is only 6% better.');
    }],

    ['the line: moved after a failure, with the count', async () => {
        const lap = offer('lap', { trust: 'user-owned', owner: P, provider: 'Claude', pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const pool = offer('pool', { provider: 'pool', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.02 } });
        const other = offer('other', { provider: 'other', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.03 } });
        const offers = [lap, pool, other];
        const r = req({ trust: ['user-owned', 'first-party'] });
        const c = ctx({ person: P, names: { lap: 'your desktop', pool: 'the cloud pool', other: 'the other pool' } });
        const first = place(r, offers, c);
        assert.equal(first.result.selected, 'lap');
        const one = escalate(first, { reason: 'quality' }, r, offers, c);
        assert.equal(one.result.selected, 'pool');
        assert.equal(one.line, 'Moved to the cloud pool: your desktop failed this once.');
        const two = escalate(one, { reason: 'quality' }, r, offers, { ...c, outcomes: one.outcomes });
        assert.equal(two.result.selected, 'other');
        assert.equal(two.line, 'Moved to the other pool: the cloud pool failed this twice.');
        const three = escalate(two, { reason: 'quality' }, r, offers, { ...c, outcomes: two.outcomes });
        assert.deepEqual(three.result, { selected: null });
        assert.match(three.line, /^Ask the person: three tries failed/);
    }],

    ['escalation: each reason, and the stop after 2', async () => {
        const a1 = offer('a1', { provider: 'paid', pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } });
        const a2 = offer('a2', { provider: 'paid', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const b = offer('b', { provider: 'other', pricing: { model: 'per-operation', marginal_usd_per_unit: 0.02 } });
        const offers = [a1, a2, b];
        const c = ctx({ person: P, step: { kind: 'code.fix' }, floor: 0.5 });
        const base = place(req(), offers, c);
        assert.equal(base.result.selected, 'a1');

        const busy = escalate(base, { reason: 'busy' }, req(), offers, c);
        assert.equal(busy.result.selected, 'a2');
        assert.equal(busy.floor, 0.5, 'busy keeps the floor');
        assert.equal(busy.rejected.find((x) => x.id === 'a1').why, 'was busy');
        assert.match(busy.line, /was busy/);

        const offline = escalate(base, { reason: 'offline' }, req(), offers, c);
        assert.equal(offline.rejected.find((x) => x.id === 'a1').why, 'was offline');

        const refused = escalate(base, { reason: 'refused' }, req(), offers, c);
        assert.equal(refused.result.selected, 'b');
        assert.equal(refused.rejected.find((x) => x.id === 'a1').why, 'the provider said no');
        assert.equal(refused.rejected.find((x) => x.id === 'a2').why, 'the provider said no', 'the whole provider is out');
        assert.match(refused.line, /said no/);

        const budget = escalate(base, { reason: 'budget' }, req(), offers, c);
        assert.equal(budget.result.selected, 'b');

        const timeout = escalate(base, { reason: 'timeout' }, req(), offers, c);
        assert.equal(timeout.result.selected, 'a2');
        assert.equal(timeout.result.objective, 'lowest-latency');
        assert.match(timeout.line, /timed out/);

        const quality = escalate(base, { reason: 'quality' }, req(), offers, c);
        assert.equal(quality.floor, 0.6);
        assert.equal(quality.escalations, 1);
        assert.equal(quality.outcomes.length, 1);
        assert.deepEqual(
            { key: quality.outcomes[0].key, kind: quality.outcomes[0].kind, ok_w: quality.outcomes[0].ok_w, n_w: quality.outcomes[0].n_w },
            { key: 'a1', kind: 'code.fix', ok_w: 0, n_w: 1 },
        );
        const second = escalate(quality, { reason: 'busy' }, req(), offers, { ...c, outcomes: quality.outcomes });
        assert.equal(second.escalations, 2);
        const third = escalate(second, { reason: 'quality' }, req(), offers, { ...c, outcomes: second.outcomes });
        assert.deepEqual(third.result, { selected: null });
        assert.equal(third.escalations, 3);
    }],

    ['the line never names a key or a path', async () => {
        const key = `usr_${'A'.repeat(26)}`;
        const r = place(req(), [offer(key, { provider: undefined, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 } })], ctx({ person: P, floor: 0.5 }));
        assert.equal(r.result.selected, key);
        assert.doesNotMatch(r.line, /usr_[0-9A-HJKMNP-TV-Z]{26}/);
        assert.match(r.line, /^On a machine:/);
        const named = lineFor({ selected: true, name: '/home/me/project', costUsd: 0.01, success: 0.9, cheapest: false });
        assert.doesNotMatch(named, /\/home/);
    }],

    ['determinism: the same inputs give the same answer 100 times', async () => {
        const cheap = offer('cheap', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.003 } });
        const dear = offer('dear', { pricing: { model: 'per-operation', marginal_usd_per_unit: 0.01 } });
        const outcomes = [{ person: P, key: 'cheap', kind: 'code.fix', ok_w: 3, n_w: 4, updated_at: ISO(T - 7 * DAY) }];
        const c = ctx({ person: P, floor: 0.5, priors: { cheap: 0.91 }, outcomes, names: { cheap: 'Cheap' } });
        const first = place(req({ objective: 'balanced' }), [cheap, dear], c);
        for (let i = 0; i < 100; i++) assert.deepEqual(place(req({ objective: 'balanced' }), [cheap, dear], c), first);
    }],
]);
