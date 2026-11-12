'use strict';
// openvibe-sdk/agents/dispatch: the Dispatcher's choices, as pure functions (agent-engine.md §3).
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { ladder, pick, escalate, harnessFor, placeFor, estimate, slice } = require('../src/agents/dispatch');

const C = [
    { id: 'credits:big', rung: 'credits', family: 'claude', tier: 'strong', caps: ['tools', 'vision', 'json', 'thinking'], context: 200000, speed: 60, price: { in: 3, out: 15 } },
    { id: 'credits:cheap', rung: 'credits', family: 'deepseek', tier: 'medium', caps: ['tools', 'json'], context: 128000, speed: 50, price: { in: 0.28, out: 0.42 } },
    { id: 'allowance:flash', rung: 'allowance', family: 'deepseek', tier: 'small', caps: ['tools', 'json'], context: 64000, speed: 90, price: { in: 0, out: 0 } },
    { id: 'machine:qwen', rung: 'machine', family: 'qwen', tier: 'small', caps: ['tools'], context: 32000, speed: 12 },
    { id: 'key:gpt', rung: 'key', family: 'openai', tier: 'strong', caps: ['tools', 'vision', 'json'], context: 400000, speed: 70, price: { in: 1.25, out: 10 } },
    { id: 'plan:codex', rung: 'plan', family: 'openai', tier: 'strong', caps: ['tools', 'files', 'shell'], context: 400000, speed: 40, available: false },
];
const ids = (l) => l.map((c) => c.id);

run([
    ['the ladder: own machine, plan, key, allowance, credits, cheapest first; what cannot is skipped with why', () => {
        assert.deepEqual(ids(ladder(C)), ['machine:qwen', 'key:gpt', 'allowance:flash', 'credits:cheap', 'credits:big']);
        const l = ladder(C, { need: { caps: ['vision'] } });
        assert.deepEqual(ids(l), ['key:gpt', 'credits:big']);
        assert.deepEqual(l.skipped.map((s) => [s.choice.id, s.why]), [
            ['credits:cheap', 'cannot vision'], ['allowance:flash', 'cannot vision'], ['machine:qwen', 'cannot vision'], ['plan:codex', 'not available now'],
        ]);
        assert.deepEqual(ids(ladder(C, { need: { context: 100000, speed: 30 } })), ['key:gpt', 'credits:cheap', 'credits:big']);
        assert.equal(ladder(C)[0].why, 'machine');
    }],
    ['a person\'s pick wins when it can; when it cannot, it is passed over with the reason', () => {
        assert.deepEqual(ids(ladder(C, { pin: 'credits:big' })).slice(0, 2), ['credits:big', 'machine:qwen']);
        assert.equal(ladder(C, { pin: 'credits:big' })[0].why, 'your pick');
        const p = pick(C, { pin: 'machine:qwen', need: { caps: ['json'] } });
        assert.equal(p.choice.id, 'key:gpt');
        assert.deepEqual(p.passedOver, { id: 'machine:qwen', why: 'cannot json' });
        assert.equal(pick([], {}).choice, null);
    }],
    ['a step that needs strength tries strong first inside a rung; the budget leaves out what it cannot pay', () => {
        assert.deepEqual(ids(ladder(C, { need: { tier: 'strong' } })), ['key:gpt', 'credits:big']);
        assert.deepEqual(ids(ladder(C, { budgetLeft: 0.002 })), ['machine:qwen', 'allowance:flash', 'credits:cheap']);
    }],
    ['escalate only on checkable evidence, to a higher tier; a grader\'s failure changes family', () => {
        const cheap = C[1];
        assert.equal(escalate(cheap, { kind: 'hunch' }, C), null, 'never on a hunch');
        assert.equal(escalate(cheap, null, C), null);
        const up = escalate(cheap, { kind: 'test', detail: '3 failing' }, C);
        assert.equal(up.choice.id, 'key:gpt');
        assert.equal(up.why, 'a test failed: 3 failing');
        assert.equal(escalate(C[4], { kind: 'schema' }, C), null, 'nothing above strong');
        const other = escalate(C[4], { kind: 'grader' }, C);
        assert.equal(other.choice.id, 'credits:big', 'a strong model of another family');
        assert.equal(escalate(cheap, { kind: 'unsure' }, C, { tried: ['key:gpt'] }).choice.id, 'credits:big');
    }],
    ['the harness by capability: the loop for turns with tools, a signed-in plan, else dsh', () => {
        const H = [{ id: 'loop', caps: ['tools'] }, { id: 'dsh', caps: ['tools', 'files', 'shell'] }, { id: 'codex', plan: 'codex', caps: ['tools', 'files', 'shell'] }, { id: 'browser', caps: ['tools', 'browser', 'desks'] }];
        assert.equal(harnessFor({ needs: ['tools'] }, H).harness.id, 'loop');
        assert.equal(harnessFor({ needs: ['files', 'shell'] }, H).harness.id, 'dsh');
        const own = harnessFor({ needs: ['files', 'shell'] }, H, { plans: ['codex'] });
        assert.deepEqual([own.harness.id, own.why], ['codex', 'your codex plan']);
        assert.equal(harnessFor({ needs: ['browser'] }, H).harness.id, 'browser');
        assert.equal(harnessFor({ needs: ['voice'] }, H), null);
    }],
    ['the place: your computer first (free), a runner for a repository elsewhere, an OpenVibe computer when allowed', () => {
        const M = [{ id: 'mch_1', name: 'Desk PC', online: true, allows: ['worker', 'desks'], repos: ['ada/site'] }, { id: 'mch_2', online: false, allows: ['worker'], repos: ['ada/game'] }];
        assert.deepEqual(placeFor({ target: { repo: 'ada/site' } }, { machines: M }).where, { kind: 'machine', id: 'mch_1', name: 'Desk PC' });
        assert.deepEqual(placeFor({ target: { repo: 'ada/game' } }, { machines: M }).where, { kind: 'runner' });
        assert.equal(placeFor({ needs: ['browser'] }, { machines: M }).where.kind, 'machine');
        assert.equal(placeFor({ needs: ['browser'] }, { machines: [] }).where.kind, 'openvibe');
        assert.equal(placeFor({ needs: ['browser'] }, { machines: [], cloud: false }), null, 'nowhere it may go');
        assert.deepEqual(placeFor({ robot: 'rbt_1' }).where, { kind: 'machine', id: 'rbt_1' });
        assert.equal(placeFor({}).where.kind, 'openvibe');
    }],
    ['a price says itself; a child\'s budget is a slice of its parent\'s', () => {
        assert.equal(estimate(C[0], { tokensIn: 1e6, tokensOut: 1e6 }), 18);
        assert.equal(estimate(C[3], { tokensIn: 1e6 }), 0, 'your own machine is free');
        assert.deepEqual(slice({ usd: 1, tokens: 10000, steps: 40 }, 0.25), { usd: 0.25, tokens: 2500, steps: 10 });
        assert.deepEqual(slice({ usd: 1 }, 7), { usd: 1 }, 'never more than the whole');
        assert.deepEqual(slice(null, 0.5), {});
    }],
]);
