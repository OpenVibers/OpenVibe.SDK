'use strict';
/**
 * openvibe-sdk/elements: validate, the host's run() with every refusal, and the state reducer.
 * No network: the owner and the products are small stubs, which is the point — the host asks them
 * and refuses before it asks when it already knows the answer.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const elements = require('../src/elements');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const EL = 'el_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const MOD = 'mod_01JAB2C3D4E5F6G7H8J9K0MNPQ';

const base = (over = {}) => ({
    id: EL,
    name: 'Make it dance',
    author: { name: 'Ada', subject: { type: 'user', id: USR } },
    sharing: 'private',
    look: { component: 'button', label: 'Make it dance', icon: 'robot', props: { size: 'large' }, style: { tint: 'accent', shape: 'pill', opacity: 1, show_label: true } },
    recipe: {
        triggers: [{ kind: 'press' }],
        conditions: { role: 'everyone' },
        actions: [{ kind: 'screen.counter', product: 'live', key: 'dances', by: 1 }],
    },
    capabilities: ['screen.counter'],
    initial_state: { dances: 0 },
    ...over,
});
const recipe = (over = {}) => ({ ...base().recipe, ...over });
const element = (over = {}) => ({ id: EL, name: 'Make it dance', capabilities: ['screen.counter'], ...over });

/** A ctx that records the calls to the owner and the products; each test overrides one part. */
function ctx(over = {}) {
    const calls = { spend: [], refund: [], send: [], hit: [], cooldown: [], daily: [] };
    const c = {
        now: Date.parse('2026-11-11T20:31:00.000Z'),
        actor: { subject: USR, name: 'Maticus', role: 'everyone' },
        element: element(),
        isLive: true,
        robotInTurn: true,
        limits: {
            cooldown: async (q) => { calls.cooldown.push(q); return 0; },
            dailyCount: async (q) => { calls.daily.push(q); return 0; },
            hit: async (q) => { calls.hit.push(q); },
        },
        spend: async (q) => { calls.spend.push(q); return { ok: true }; },
        refund: async (q) => { calls.refund.push(q); },
        send: async (a, info) => { calls.send.push({ action: a, info }); return { ok: true, result: { id: a.kind } }; },
        ...over,
    };
    c.calls = calls;
    return c;
}

run([
    ['validate accepts a full element and a mod reference', async () => {
        assert.deepEqual(elements.validate(base()), { valid: true, errors: [] });
        const modded = base({ mod: { id: MOD, version: '1.0.0', sha256: 'a'.repeat(64), capabilities: ['screen.counter'] } });
        assert.deepEqual(elements.validate(modded), { valid: true, errors: [] });
    }],

    ['validate refuses the recipe using a capability the element did not declare', async () => {
        const r = elements.validate(base({ capabilities: ['screen.alert'] }));
        assert.equal(r.valid, false);
        assert.ok(r.errors.some((e) => /did not declare/.test(e.message)), JSON.stringify(r.errors));
    }],

    ['validate refuses an unknown action, a wrong product and a malformed trigger', async () => {
        const unknown = base({ recipe: recipe({ actions: [{ kind: 'robot.dance', product: 'bot' }] }), capabilities: ['robot.say'] });
        assert.ok(elements.validate(unknown).errors.some((e) => /is not an action/.test(e.message)));
        const product = base({ recipe: recipe({ actions: [{ kind: 'chat.message', product: 'bot', text: 'hi' }] }), capabilities: ['chat.message'] });
        assert.ok(elements.validate(product).errors.some((e) => /authorised by chat only/.test(e.message)));
        const command = base({ recipe: recipe({ triggers: [{ kind: 'chat_command', command: 'dance' }] }) });
        assert.ok(elements.validate(command).errors.some((e) => /lowercase !command/.test(e.message)));
    }],

    ['validate refuses a mod that asks beyond the element and a bad state value', async () => {
        const mod = base({ mod: { id: MOD, version: '1.0.0', sha256: 'a'.repeat(64), capabilities: ['robot.say'] } });
        assert.ok(elements.validate(mod).errors.some((e) => /did not declare/.test(e.message)));
        const state = base({ initial_state: { wheel: { entries: ['a'] } } });
        assert.ok(elements.validate(state).errors.some((e) => /state value/.test(e.message)));
        const tint = base({ look: { component: 'button', label: 'x', style: { tint: '#ff0000' } } });
        assert.ok(elements.validate(tint).errors.some((e) => /theme token/.test(e.message)));
    }],

    ['run refuses a role below the condition', async () => {
        const c = ctx({ actor: { subject: USR, name: 'Maticus', role: 'everyone' } });
        const r = await elements.run(recipe({ conditions: { role: 'follower' } }), { kind: 'press' }, c);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'role');
        assert.equal(c.calls.send.length, 0);
    }],

    ['run admits a higher role than the condition', async () => {
        const c = ctx({ actor: { subject: USR, name: 'Maticus', role: 'subscriber' } });
        const r = await elements.run(recipe({ conditions: { role: 'follower' } }), { kind: 'press' }, c);
        assert.equal(r.ok, true);
    }],

    ['run refuses a live-only element while the channel is not live', async () => {
        const r = await elements.run(recipe({ conditions: { live_only: true } }), { kind: 'press' }, ctx({ isLive: false }));
        assert.equal(r.code, 'not_live');
        const unknown = await elements.run(recipe({ conditions: { live_only: true } }), { kind: 'press' }, ctx({ isLive: undefined }));
        assert.equal(unknown.code, 'not_live', 'an unstated live state fails closed');
    }],

    ['run refuses a robot action when it is not the presser\'s turn', async () => {
        const robot = base({ recipe: recipe({ actions: [{ kind: 'robot.say', product: 'bot', text: 'hello' }] }), capabilities: ['robot.say'] });
        const c = ctx({ robotInTurn: false, element: element({ capabilities: ['robot.say'] }) });
        const r = await elements.run(robot.recipe, { kind: 'press' }, c);
        assert.equal(r.code, 'robot_turn');
        assert.equal(c.calls.send.length, 0);

        const only = ctx({ robotInTurn: undefined, element: element({ capabilities: ['robot.say'] }) });
        const r2 = await elements.run(robot.recipe, { kind: 'press' }, { ...only, ...{ robotInTurn: undefined } });
        assert.equal(r2.ok, true, 'robot_turn_only is off, so Bot decides');
        const r3 = await elements.run(recipe({ conditions: { robot_turn_only: true }, actions: robot.recipe.actions }), { kind: 'press' }, only);
        assert.equal(r3.code, 'robot_turn');
    }],

    ['run refuses a per-person cooldown and says how long', async () => {
        const c = ctx({ limits: { cooldown: async () => 30000, dailyCount: async () => 0, hit: async () => {} } });
        const r = await elements.run(recipe({ conditions: { cooldown: { per_person_seconds: 60 } } }), { kind: 'press' }, c);
        assert.equal(r.code, 'cooldown');
        assert.equal(r.retryAfterMs, 30000);
        assert.match(r.message, /try again in 30 seconds/);
        assert.equal(c.calls.send.length, 0);
    }],

    ['run refuses an overall cooldown', async () => {
        const c = ctx({ limits: { cooldown: async (q) => (q.scope === 'overall' ? 5000 : 0), dailyCount: async () => 0, hit: async () => {} } });
        const r = await elements.run(recipe({ conditions: { cooldown: { per_person_seconds: 10, overall_seconds: 30 } } }), { kind: 'press' }, c);
        assert.equal(r.code, 'cooldown');
        assert.equal(r.scope, 'overall');
    }],

    ['run refuses a per-person daily cap and an overall daily cap', async () => {
        const person = ctx({ limits: { cooldown: async () => 0, dailyCount: async (q) => (q.scope === 'person' ? 5 : 0), hit: async () => {} } });
        const r = await elements.run(recipe({ conditions: { daily_cap: { per_person: 5 } } }), { kind: 'press' }, person);
        assert.equal(r.code, 'daily_cap');
        assert.equal(r.scope, 'person');
        const overall = ctx({ limits: { cooldown: async () => 0, dailyCount: async (q) => (q.scope === 'overall' ? 100 : 0), hit: async () => {} } });
        const r2 = await elements.run(recipe({ conditions: { daily_cap: { overall: 100 } } }), { kind: 'press' }, overall);
        assert.equal(r2.code, 'daily_cap');
        assert.equal(r2.scope, 'overall');
    }],

    ['run checks the cost with the owner and refuses when it says no', async () => {
        const c = ctx({ spend: async (q) => { c_spent.push(q); return { ok: false, message: 'Not enough channel points (40 of 50).' }; } });
        const c_spent = [];
        const r = await elements.run(recipe({ conditions: { cost: { points: 50 } } }), { kind: 'press' }, c);
        assert.equal(r.code, 'points');
        assert.match(r.message, /40 of 50/);
        assert.equal(c_spent.length, 1);
        assert.equal(c_spent[0].points, 50);
        assert.equal(c.calls.send.length, 0);
        assert.equal(c.calls.spend.length, 0, 'the overridden spend is the owner');
    }],

    ['run refuses an undeclared capability before it spends or sends', async () => {
        const c = ctx({ element: element({ capabilities: ['screen.alert'] }) });
        const r = await elements.run(recipe(), { kind: 'press' }, c);
        assert.equal(r.code, 'capability');
        assert.match(r.message, /did not declare screen.counter/);
        assert.equal(c.calls.spend.length, 0);
        assert.equal(c.calls.send.length, 0);
    }],

    ['run draws the chance before it charges and a refused draw costs nothing', async () => {
        const c = ctx({ random: () => 0.9 });
        const r = await elements.run(recipe({ conditions: { chance: { one_in: 10 }, cost: { points: 50 } } }), { kind: 'press' }, c);
        assert.equal(r.code, 'chance');
        assert.equal(c.calls.spend.length, 0);
        const win = ctx({ random: () => 0.05 });
        const r2 = await elements.run(recipe({ conditions: { chance: { one_in: 10 }, cost: { points: 50 } } }), { kind: 'press' }, win);
        assert.equal(r2.ok, true);
        assert.equal(win.calls.spend.length, 1);
    }],

    ['run sends every action in order to the product that authorises it', async () => {
        const two = base({
            recipe: recipe({ actions: [
                { kind: 'screen.counter', product: 'live', key: 'dances', by: 1 },
                { kind: 'chat.message', product: 'chat', text: 'Ada made it dance!' },
            ] }),
            capabilities: ['screen.counter', 'chat.message'],
        });
        const c = ctx({ element: element({ capabilities: ['screen.counter', 'chat.message'] }) });
        const r = await elements.run(two.recipe, { kind: 'press' }, c);
        assert.equal(r.ok, true);
        assert.deepEqual(r.actions.map((x) => x.action.kind), ['screen.counter', 'chat.message']);
        assert.deepEqual(c.calls.send.map((x) => x.info.product), ['live', 'chat']);
        assert.equal(c.calls.hit.length, 1, 'a successful press records its limits once');
    }],

    ['run refunds the points when a product refuses and reports the refusal', async () => {
        const c = ctx({
            element: element({ capabilities: ['screen.counter', 'screen.alert'] }),
            spend: async () => ({ ok: true }),
            send: async (a) => (a.kind === 'screen.counter' ? { ok: true, result: { revision: 1 } } : { ok: false, message: 'the overlay is off' }),
        });
        const two = base({
            recipe: recipe({ actions: [
                { kind: 'screen.counter', product: 'live', key: 'dances', by: 1 },
                { kind: 'screen.alert', product: 'live', title: 'Dance!' },
            ], conditions: { cost: { points: 50 } } }),
            capabilities: ['screen.counter', 'screen.alert'],
        });
        const r = await elements.run(two.recipe, { kind: 'press' }, c);
        assert.equal(r.code, 'action');
        assert.equal(r.refusedAction, 'screen.alert');
        assert.equal(r.refunded, true);
        assert.equal(c.calls.refund.length, 1);
        assert.equal(c.calls.refund[0].points, 50);
        assert.equal(r.pointsSpent, 0);
    }],

    ['run refuses a trigger the recipe does not listen for', async () => {
        const r = await elements.run(recipe({ triggers: [{ kind: 'chat_command', command: '!dance' }] }), { kind: 'chat_command', command: '!wave' }, ctx());
        assert.equal(r.code, 'trigger');
        assert.equal(r.ok, false);
    }],

    ['run accepts the declared chat command', async () => {
        const r = await elements.run(recipe({ triggers: [{ kind: 'chat_command', command: '!dance' }] }), { kind: 'chat_command', command: '!dance' }, ctx());
        assert.equal(r.ok, true);
    }],

    ['run refuses a recipe with nothing to do', async () => {
        const r = await elements.run({ triggers: [{ kind: 'press' }], actions: [] }, { kind: 'press' }, ctx());
        assert.equal(r.code, 'invalid');
    }],

    ['reduce counts up from zero, sets values and increments the revision once', async () => {
        const start = { values: { dances: 0 }, revision: 4 };
        const one = elements.reduce(start, [{ kind: 'screen.counter', key: 'dances', by: 1 }]);
        assert.deepEqual(one.values, { dances: 1 });
        assert.equal(one.revision, 5);
        assert.equal(one.changed, true);
        const set = elements.reduce(one, [
            { kind: 'screen.state', key: 'lit', value: true },
            { kind: 'screen.state', key: 'wheel', value: ['a', 'b'] },
            { kind: 'chat.message', text: 'not state' },
        ]);
        assert.deepEqual(set.values, { dances: 1, lit: true, wheel: ['a', 'b'] });
        assert.equal(set.revision, 6);
        const same = elements.reduce(set, [{ kind: 'screen.counter', key: 'dances', by: 0 }]);
        assert.equal(same.changed, false);
        assert.equal(same.revision, 6);
    }],

    ['reduce reports an invalid change without touching the store', async () => {
        const state = { values: { name: 'ada' }, revision: 1 };
        const r = elements.reduce(state, [{ kind: 'screen.counter', key: 'name', by: 1 }]);
        assert.equal(r.changed, false);
        assert.equal(r.revision, 1);
        assert.equal(r.errors.length, 1);
        const object = elements.reduce(state, [{ kind: 'screen.state', key: 'wheel', value: { a: 1 } }]);
        assert.equal(object.errors.length, 1, 'screen.state never stores an object');
        const long = elements.reduce(state, [{ kind: 'screen.state', key: 'name', value: 'x'.repeat(201) }]);
        assert.equal(long.errors.length, 1);
    }],

    ['reduce holds at most 32 keys', async () => {
        const values = {};
        for (let i = 0; i < 32; i++) values[`k${i}`] = i;
        const r = elements.reduce({ values, revision: 1 }, [{ kind: 'screen.state', key: 'extra', value: 1 }]);
        assert.equal(r.errors.length, 1);
        assert.equal(r.values.extra, undefined);
    }],

    ['the exported catalogs agree with the action and trigger ids', async () => {
        assert.equal(elements.ACTION_KINDS.length, Object.keys(elements.PRODUCTS).length);
        assert.ok(elements.ACTION_SET.has('robot.drive_pulse') && elements.PRODUCTS['robot.drive_pulse'] === 'bot');
        assert.ok(elements.TRIGGER_SET.has('chat_command') && elements.TRIGGER_SET.has('press'));
        assert.deepEqual(elements.ROLE_RANK, { everyone: 0, follower: 1, subscriber: 2, vip: 3, operator: 4, owner: 5 });
    }],
]);
