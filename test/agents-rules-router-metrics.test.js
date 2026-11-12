'use strict';
// openvibe-sdk/agents/rules, agents/router and agents/metrics (one-system-v2.md; agents.permission-rule@1, agents.run@1
// 1.4.0 metrics): permissions as data with an unattended set and the floor, routing on a Decisions probability with a
// budget-calibrated threshold, and a recorder that keeps the charged cost first.
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const rules = require('../src/agents/rules');
const router = require('../src/agents/router');
const metrics = require('../src/agents/metrics');

run([
    ['rules: the last match wins; the level decides when none does; the floor always asks', () => {
        const R = [{ action: 'ov:*', effect: 'allow' }, { action: 'ov:live.chat.post', effect: 'ask' }];
        assert.equal(rules.decide(R, { action: 'ov:live.chat.read' }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'ov:live.chat.post' }).effect, 'ask', 'the narrower rule after the broad one');
        assert.equal(rules.decide([], { action: 'machine:shell', kind: 'exec' }, { level: 'ask' }).effect, 'ask');
        assert.equal(rules.decide([], { action: 'machine:shell', kind: 'exec' }, { level: 'auto-edits' }).effect, 'allow');
        assert.equal(rules.decide([], { action: 'ov:billing.pay', kind: 'other' }, { level: 'auto-edits' }).effect, 'ask');
        const pay = rules.decide([{ action: '*', effect: 'allow' }], { action: 'ov:billing.pay', floor: true }, { level: 'full' });
        assert.deepEqual([pay.effect, pay.why], ['ask', 'the floor always asks']);
        assert.equal(rules.decide([{ action: 'ov:billing.pay', effect: 'deny' }], { action: 'ov:billing.pay', floor: true }).effect, 'deny', 'a deny still denies');
    }],
    ['rules: resources are paths, domains or command prefixes; when limits a rule', () => {
        const R = [{ action: 'machine:files', resource: 'src/**', effect: 'allow' }, { action: 'network', resource: '*.openvibe.live', effect: 'allow' }, { action: 'machine:shell', resource: 'npm test', effect: 'allow', when: 'unattended' }];
        assert.equal(rules.decide(R, { action: 'machine:files', resource: 'src/a/b.js' }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'machine:files', resource: 'secrets/.env' }).effect, 'ask');
        assert.equal(rules.decide(R, { action: 'network', resource: 'api.openvibe.live' }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'network', resource: 'openvibe.live' }).effect, 'allow', 'the base domain too');
        assert.equal(rules.decide(R, { action: 'network', resource: 'evil-openvibe.live' }).effect, 'ask');
        assert.equal(rules.decide(R, { action: 'machine:shell', resource: 'npm test -- core' }, { attended: false }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'machine:shell', resource: 'npm test' }, { attended: true }).effect, 'ask', 'an unattended rule does not hold while someone is there');
    }],
    ['rules: unattended work never waits; the floor unattended is denied', () => {
        assert.equal(rules.decide([], { action: 'ov:live.chat.post' }, { attended: false, level: 'ask' }).effect, 'deny');
        assert.equal(rules.decide([], { action: 'ov:live.chat.post' }, { attended: false, level: 'approve-for-me' }).effect, 'allow');
        assert.equal(rules.decide([], { action: 'ov:billing.pay', floor: true }, { attended: false, level: 'full' }).effect, 'deny');
    }],
    ['rules: a blueprint compiles to rules: only its tools, never the hooks, its network', () => {
        const doc = { hands: { tools: [{ tool: 'ov:live.chat.read', mode: 'allow' }, { tool: 'machine:files', mode: 'allow' }] }, rules: { level: 'auto-edits', sandbox: 'workspace-write', network: { mode: 'listed', domains: ['*.openvibe.live'] } } };
        const R = rules.fromBlueprint(doc);
        assert.equal(rules.decide(R, { action: 'ov:live.chat.read' }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'ov:community.post.create' }).effect, 'deny', 'a tool it does not name');
        assert.equal(rules.decide(R, { action: 'machine:files', resource: 'repo/.git/hooks/pre-commit' }).effect, 'deny');
        assert.equal(rules.decide(R, { action: 'machine:files', resource: 'repo/src/x.js' }).effect, 'allow');
        assert.equal(rules.decide(R, { action: 'network', resource: 'example.org' }).effect, 'deny');
        assert.equal(rules.decide(R, { action: 'network', resource: 'cdn.openvibe.live' }).effect, 'allow');
        const ro = rules.fromBlueprint({ hands: { tools: [{ tool: 'machine:files', mode: 'allow' }] }, rules: { sandbox: 'read-only' } });
        assert.equal(rules.decide(ro, { action: 'machine:files', resource: 'a.txt' }).effect, 'deny', 'read-only writes nothing');
    }],
    ['router: a Decisions probability and a threshold calibrated to a budget', () => {
        const q = router.question({ text: 'Refactor the payment retries' });
        assert.equal(q.questions.needs_strong.type, 'noul');
        assert.equal(q.prefer, 'calibrated');
        assert.equal(router.probability({ answers: { needs_strong: { probability: 0.81 } } }), 0.81);
        assert.equal(router.probability({}), null);
        assert.deepEqual(router.route({ p: 0.81, threshold: 0.7, small: 'flash', strong: 'pro' }).choice, 'pro');
        assert.deepEqual(router.route({ p: 0.2, threshold: 0.7, small: 'flash', strong: 'pro' }).choice, 'flash');
        assert.equal(router.route({ p: null, small: 'flash', strong: 'pro' }).choice, 'flash', 'no prediction: cheaper, escalate on evidence');
        const h = Array.from({ length: 10 }, (_, i) => ({ p: i / 10 }));
        assert.equal(router.calibrate(h, { strongShare: 0.2 }).threshold, 0.8, 'two of ten at or above it');
        assert.equal(h.filter((x) => x.p >= router.calibrate(h, { strongShare: 0.3 }).threshold).length, 3);
        assert.equal(router.calibrate([], {}).threshold, 0.5);
    }],
    ['router: the strategy chain and the quality-cost points', async () => {
        assert.equal((await router.chain({ text: 'x' }, { pick: 'mine', small: 'a', strong: 'b' })).choice, 'mine');
        assert.equal((await router.chain({ text: 'x' }, { pin: 'pinned', small: 'a', strong: 'b' })).choice, 'pinned');
        assert.equal((await router.chain({ text: 'x' }, { ask: async () => ({ answers: { needs_strong: { probability: 0.9 } } }), threshold: 0.5, small: 'a', strong: 'b' })).choice, 'b');
        assert.equal((await router.chain({ text: 'x' }, { ask: async () => { throw new Error('down'); }, small: 'a', strong: 'b' })).choice, 'a', 'Decisions down: the cheaper one');
        const hist = [{ p: 0.9, strong: true, ok: true, usd: 0.01 }, { p: 0.1, strong: false, ok: true, usd: 0.001 }, { p: 0.6, strong: false, ok: false, usd: 0.001 }];
        const pts = router.outcomes(hist, [0, 1]);
        assert.equal(pts.length, 2);
        assert.ok(pts.every((x) => 'quality' in x && 'usd_per_step' in x));
    }],
    ['metrics: charged first, an estimate apart, unknown is null; a named exit; evidence', () => {
        let t = 1000;
        const rec = metrics.createRecorder({ now: () => t });
        assert.deepEqual([rec.snapshot().charged_usd, rec.snapshot().estimated_usd], [null, null], 'nothing known is null, never 0');
        rec.call({ tokens_in: 1000, tokens_out: 100, cache_read: 800, charged_usd: 0.002 }).step();
        rec.call({ tokens_in: 500, tokens_out: 50, estimated_usd: 0.0007 }).step();
        rec.evidence({ kind: 'test', passed: true, detail: '12 passed' });
        assert.throws(() => rec.evidence({ kind: 'vibes', passed: true }), TypeError);
        t = 4100;
        const m = rec.end('done');
        assert.deepEqual([m.charged_usd, m.estimated_usd, m.tokens_in, m.tokens_out, m.cache_read, m.steps, m.latency_ms, m.exit], [0.002, 0.0007, 1500, 150, 800, 2, 3100, 'done']);
        assert.equal(metrics.createRecorder().end('crashed').exit, 'error', 'an unknown exit is error');
    }],
    ['metrics: pass@k, pass^k and flake rate', () => {
        assert.equal(metrics.passAtK([true, false, false, false], 1), 0.25);
        assert.equal(metrics.passAtK([true, false, false, false], 4), 1);
        assert.equal(metrics.passAtK([false, false], 1), 0);
        assert.equal(metrics.passHatK([true, true, false, true], 2), 0.5625);
        assert.equal(metrics.flakeRate([[true, true], [true, false], [false, false], [false, true, true]]), 0.5);
        assert.equal(metrics.flakeRate([]), null);
    }],
]);
