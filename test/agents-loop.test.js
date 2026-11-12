'use strict';
// openvibe-sdk/agents/loop: the light agent loop (a port of pi's, MIT) and its step sink, driven by a scripted model.
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { runLoop, createStepSink, checkInput, STOPS } = require('../src/agents/loop');

/** A model that answers from a script, one turn per call, and remembers what it was shown. */
function scripted(turns) {
    const seen = [];
    return {
        id: 'test:scripted',
        seen,
        async complete(req) {
            seen.push(req.messages.map((m) => `${m.role}:${m.text || (m.tool_calls || []).map((c) => c.name).join('+') || ''}`));
            const t = turns.shift();
            if (!t) return { text: 'Done.', stop: 'stop' };
            if (t.throws) throw new Error(t.throws);
            if (t.stream) for (const d of t.stream) await req.onDelta(d);
            return t;
        },
    };
}
const tool = (name, run, extra = {}) => ({ name, description: name, run, ...extra });

run([
    ['a question answered with a tool, then words; the steps follow it in order', async () => {
        const model = scripted([
            { thinking: 'They want a reminder.', tool_calls: [{ id: 'c1', name: 'remind', input: { what: 'stretch', every: 120 } }], usage: { tokens: 100 }, cost: { usd: 0.001 } },
            { stream: [{ text: 'Reminder ' }, { text: 'set.' }], usage: { tokens: 50 }, cost: { usd: 0.0005 } },
        ]);
        const steps = new Map(); const deltas = [];
        const sink = createStepSink({ runId: 'r1', startSeq: 2, append: (s) => steps.set(s.seq, { ...s }), update: (n, p) => Object.assign(steps.get(n), p), delta: (n, t) => deltas.push([n, t]) });
        const remind = tool('remind', async (input) => ({ result: { id: 'rem_1', ...input }, cost: { usd: 0.0001 } }), { inputSchema: { type: 'object', required: ['what'], properties: { what: { type: 'string' }, every: { type: 'integer' } } } });
        const out = await runLoop({ model, tools: [remind], prompts: [{ role: 'user', text: 'Remind me to stretch every 2 hours' }], onEvent: sink });
        assert.equal(out.stop, 'done');
        assert.equal(out.turns, 2);
        assert.deepEqual(out.usage, { tokens: 150 });
        assert.equal(out.cost.usd, 0.0016, 'model turns and the tool\'s own cost');
        assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
        assert.deepEqual(model.seen[1], ['user:Remind me to stretch every 2 hours', 'assistant:remind', 'tool:{"id":"rem_1","what":"stretch","every":120}'], 'the second turn sees the tool\'s result');
        const list = [...steps.values()];
        assert.deepEqual(list.map((s) => [s.seq, s.kind, s.from, s.status]), [
            [2, 'message', 'person', 'done'], [3, 'think', 'agent', 'done'], [4, 'tool', 'tool', 'done'], [5, 'message', 'agent', 'done'],
        ]);
        assert.equal(list[2].tool_call.name, 'remind');
        assert.deepEqual(list[2].result, { id: 'rem_1', what: 'stretch', every: 120 });
        assert.equal(list[3].text, 'Reminder set.');
        assert.deepEqual(deltas, [[5, 'Reminder '], [5, 'set.']], 'the words stream into their step');
        assert.ok(list.every((s) => s.run_id === 'r1' && s.turn === 0));
    }],
    ['parallel tools keep the model\'s order; a sequential tool runs them one by one', async () => {
        const order = [];
        const slow = tool('slow', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('slow'); return { result: 'slow' }; });
        const fast = tool('fast', async () => { order.push('fast'); return { result: 'fast' }; });
        let out = await runLoop({ model: scripted([{ tool_calls: [{ id: 'a', name: 'slow', input: {} }, { id: 'b', name: 'fast', input: {} }] }]), tools: [slow, fast], prompts: [{ role: 'user', text: 'go' }] });
        assert.deepEqual(order, ['fast', 'slow'], 'run together');
        assert.deepEqual(out.messages.filter((m) => m.role === 'tool').map((m) => m.name), ['slow', 'fast'], 'results in the model\'s order');
        order.length = 0;
        out = await runLoop({ model: scripted([{ tool_calls: [{ id: 'a', name: 'slow', input: {} }, { id: 'b', name: 'fast', input: {} }] }]), tools: [{ ...slow, sequential: true }, fast], prompts: [{ role: 'user', text: 'go' }] });
        assert.deepEqual(order, ['slow', 'fast'], 'one by one');
    }],
    ['an unknown tool, input its schema refuses, a throw and a timeout come back as errors, never a crash', async () => {
        const boom = tool('boom', async () => { throw new Error('the disk is full'); });
        const hang = tool('hang', (input, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ result: 'late' }))), { timeoutMs: 40 });
        const strict = tool('strict', async () => ({ result: 'ok' }), { inputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } }, additionalProperties: false } });
        const out = await runLoop({
            model: scripted([{ tool_calls: [{ id: '1', name: 'nope', input: {} }, { id: '2', name: 'boom', input: {} }, { id: '3', name: 'hang', input: {} }, { id: '4', name: 'strict', input: { n: 1.5 } }, { id: '5', name: 'strict', input: { n: 1, x: 2 } }] }]),
            tools: [boom, hang, strict], prompts: [{ role: 'user', text: 'go' }],
        });
        const errs = out.messages.filter((m) => m.role === 'tool').map((m) => [m.name, m.is_error, m.result.error]);
        assert.deepEqual(errs, [
            ['nope', true, 'There is no tool named nope.'],
            ['boom', true, 'the disk is full'],
            ['hang', true, 'hang took longer than 40 ms and was stopped.'],
            ['strict', true, 'The input does not fit strict: input.n should be integer.'],
            ['strict', true, 'The input does not fit strict: input.x is not an input of this tool.'],
        ]);
        assert.equal(out.stop, 'done', 'the model was told and finished');
    }],
    ['a call cut off by the output limit is never run', async () => {
        let ran = 0;
        const out = await runLoop({ model: scripted([{ stop: 'length', tool_calls: [{ id: '1', name: 'send', input: { to: 'every' } }] }]), tools: [tool('send', async () => { ran++; return { result: 'sent' }; })], prompts: [{ role: 'user', text: 'go' }] });
        assert.equal(ran, 0);
        assert.match(out.messages.find((m) => m.role === 'tool').result.error, /hit the output limit/);
    }],
    ['the approval gate blocks a call; terminate ends the run', async () => {
        const asked = [];
        const pay = tool('pay', async () => ({ result: 'paid' }));
        let out = await runLoop({ model: scripted([{ tool_calls: [{ id: '1', name: 'pay', input: { usd: 5 } }] }]), tools: [pay], prompts: [{ role: 'user', text: 'pay' }],
            beforeToolCall: async ({ toolCall, input }) => { asked.push([toolCall.name, input.usd]); return { block: true, reason: 'The person said not now.' }; } });
        assert.deepEqual(asked, [['pay', 5]]);
        assert.equal(out.messages.find((m) => m.role === 'tool').result.error, 'The person said not now.');
        assert.equal(out.stop, 'done');
        out = await runLoop({ model: scripted([{ tool_calls: [{ id: '1', name: 'finish', input: {} }] }, { text: 'never asked' }]), tools: [tool('finish', async () => ({ result: 'over', terminate: true }))], prompts: [{ role: 'user', text: 'go' }] });
        assert.equal(out.stop, 'terminated');
        assert.equal(out.turns, 1, 'no turn after a tool that ends the run');
    }],
    ['the same call repeated gets a reminder; an idempotent tool answers from the memo', async () => {
        let looks = 0, reads = 0;
        const look = tool('look', async () => { looks++; return { result: 'same' }; });
        const read = tool('read', async () => { reads++; return { result: 'page' }; }, { idempotent: true });
        const call = (id, name) => ({ tool_calls: [{ id, name, input: { q: 'x' } }] });
        const out = await runLoop({ model: scripted([call('1', 'look'), call('2', 'look'), call('3', 'look'), call('4', 'look'), call('5', 'read'), call('6', 'read')]), tools: [look, read], prompts: [{ role: 'user', text: 'go' }], repeatLimit: 3 });
        assert.equal(looks, 3, 'the fourth was not run');
        assert.match(out.messages.filter((m) => m.name === 'look').pop().result.error, /already called look with this same input 3 times/);
        assert.equal(reads, 1, 'read once');
        assert.equal(out.messages.filter((m) => m.name === 'read').pop().memo, true);
    }],
    ['the budget stops it between turns; the model is told what is left', async () => {
        const model = scripted([{ tool_calls: [{ id: '1', name: 'x', input: {} }], cost: { usd: 0.03 } }, { tool_calls: [{ id: '2', name: 'x', input: { a: 1 } }], cost: { usd: 0.03 } }, { text: 'never' }]);
        const lefts = [];
        const wrapped = { ...model, complete: (req) => { lefts.push(req.budgetLeft); return model.complete(req); } };
        const out = await runLoop({ model: wrapped, tools: [tool('x', async () => ({ result: 1 }))], prompts: [{ role: 'user', text: 'go' }], budget: { usd: 0.05 } });
        assert.equal(out.stop, 'budget');
        assert.equal(out.turns, 2);
        assert.deepEqual(lefts.map((l) => Math.round(l.usd * 100) / 100), [0.05, 0.02]);
        const capped = await runLoop({ model: scripted([{ tool_calls: [{ id: '1', name: 'x', input: {} }] }, { tool_calls: [{ id: '2', name: 'x', input: { b: 1 } }] }, { text: 'no' }]), tools: [tool('x', async () => ({ result: 1 }))], prompts: [{ role: 'user', text: 'go' }], maxTurns: 2 });
        assert.equal(capped.stop, 'turns');
    }],
    ['steering is taken before the next turn; a follow-up wakes it after it would stop; a person\'s word opens a turn', async () => {
        const queue = [];   // the person writes while the tool runs
        let follow = [{ role: 'user', text: 'and a sound' }];
        const model = scripted([{ tool_calls: [{ id: '1', name: 'draw', input: {} }] }, { text: 'Purple it is.' }, { text: 'Sound added.' }]);
        const steps = [];
        const out = await runLoop({ model, tools: [tool('draw', async () => { queue.push({ role: 'user', text: 'make it purple' }); return { result: 'bar' }; })], prompts: [{ role: 'user', text: 'a goal bar' }],
            steering: () => queue.splice(0), followUp: () => { const f = follow; follow = []; return f; },
            onEvent: createStepSink({ append: (s) => steps.push(s), startSeq: 1 }) });
        assert.equal(out.stop, 'done');
        assert.deepEqual(out.messages.filter((m) => m.role === 'user').map((m) => m.text), ['a goal bar', 'make it purple', 'and a sound']);
        assert.deepEqual(model.seen[1].slice(-1), ['user:make it purple'], 'the steering words reached the next turn');
        assert.deepEqual(steps.filter((s) => s.from === 'person').map((s) => [s.text, s.turn]), [['a goal bar', 0], ['make it purple', 1], ['and a sound', 2]]);
    }],
    ['a model that throws ends the run with stop: error; an abort stops it; ui-only entries never reach the model', async () => {
        const steps = [];
        let out = await runLoop({ model: scripted([{ throws: 'provider down' }]), prompts: [{ role: 'user', text: 'hi' }], onEvent: createStepSink({ append: (s) => steps.push(s) }) });
        assert.equal(out.stop, 'error');
        assert.equal(out.error, 'provider down');
        assert.deepEqual(steps.map((s) => [s.kind, s.from, s.status, s.text]), [['message', 'person', 'done', 'hi'], ['message', 'system', 'failed', 'provider down']]);
        const ctl = new AbortController(); ctl.abort();
        out = await runLoop({ model: scripted([{ text: 'no' }]), prompts: [{ role: 'user', text: 'hi' }], signal: ctl.signal });
        assert.equal(out.stop, 'aborted');
        const model = scripted([{ text: 'ok' }]);
        await runLoop({ model, messages: [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'a card', ui_only: true }], prompts: [{ role: 'user', text: 'new' }] });
        assert.deepEqual(model.seen[0], ['user:old', 'user:new']);
        assert.ok(STOPS.includes('budget'));
    }],
    ['a long tool output is clipped before the model sees it', async () => {
        const model = scripted([{ tool_calls: [{ id: '1', name: 'dump', input: {} }] }, { text: 'ok' }]);
        const out = await runLoop({ model, tools: [tool('dump', async () => ({ result: 'x'.repeat(500) }))], prompts: [{ role: 'user', text: 'go' }], toolOutputLimit: 100 });
        const m = out.messages.find((x) => x.role === 'tool');
        assert.ok(m.text.length < 160 && /more characters left out/.test(m.text));
        assert.equal(m.result.length, 500, 'the whole result is kept in the thread');
    }],
    ['checkInput: the subset tools use', () => {
        const s = { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { type: 'array', items: { type: 'number' } } } };
        assert.equal(checkInput(s, { a: 'x', b: [1, 2] }), null);
        assert.equal(checkInput(s, { b: [] }), 'input.a is required');
        assert.equal(checkInput(s, { a: 'z' }), 'input.a should be one of "x", "y"');
        assert.equal(checkInput(s, { a: 'x', b: [1, 'two'] }), 'input.b[1] should be number');
    }],
    ['no model, no loop', async () => {
        await assert.rejects(() => runLoop({}), /a model adapter with complete\(\) is required/);
        assert.throws(() => createStepSink({}), /needs append/);
    }],
]);
