'use strict';
// openvibe-sdk/agents/blueprint: make your own agent (agent-blueprints.md). The blueprints here are Contracts'
// agents.blueprint@1 fixtures (Clip finder, Vibe, a tool for other agents).
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const bp = require('../src/agents/blueprint');

const T = '2026-11-12T21:00:00Z';
const clip = () => ({
    id: 'bp_01JD8C4QJ7Z3K9W2X5V6N1M0PA', version: 3, state: 'published', name: 'Clip finder',
    summary: 'Watches your stream\'s chat and speech, and clips the moments people react to.',
    author: { type: 'user', id: 'usr_01JD8C4QJ7Z3K9W2X5V6N1M0PB' }, visibility: 'public', forked_from: null, licence: 'MIT',
    inputs: [{ id: 'channel', type: 'channel', label: 'Your channel', required: true }],
    face: { avatar: 'preset:scissors', hue: 270, voice: null, tone: 'Short and cheerful.' },
    brain: { pick: 'auto', rungs: ['machine', 'plan', 'key', 'allowance', 'credits'], max_usd_per_m: 1, caps: ['tools'], decisions: true },
    knows: { instructions: 'You watch {{channel}}\'s stream. Clip what chat reacts to.' },
    hands: { tools: [
        { tool: 'ov:live.transcript.read', mode: 'allow' },
        { tool: 'ov:live.chat.read', mode: 'allow' },
        { tool: 'ov:media.clip.create', mode: 'allow' },
        { tool: 'ov:live.chat.post', mode: 'ask' },
    ], search: false },
    places: { order: ['none'] },
    memory: { scope: 'person', remember: 'Which moments the streamer kept.', keep_days: 30 },
    rules: { level: 'auto-edits', budget: { run_usd: 0.05, day_usd: 0.5 }, who: { may: 'owner' } },
    when: [{ kind: 'event', event: 'live.stream.started', where: { service: 'live', kind: 'channel', id: '{{channel}}' } }],
    makes: { answer: ['card:clip'], serve: { a2a: false, mcp: false } },
    team: null, created_at: T, updated_at: T, published_at: T,
});
const install = { agent: 'agt_01JD8C4QJ7Z3K9W2X5V6N1M0PJ', owner: { type: 'user', id: 'usr_01JD8C4QJ7Z3K9W2X5V6N1M0PK' }, blueprint: 'bp_01JD8C4QJ7Z3K9W2X5V6N1M0PA@3', inputs: { channel: 'maticus' }, agreed: [], places: { own: ['dev_desk'], shared: [] }, updates: 'same-or-less' };
const why = (doc) => bp.validate(doc).errors.map((e) => `${e.at} ${e.why}`).join(' | ');

run([
    ['a whole blueprint is valid; the rules a schema cannot say are kept', () => {
        assert.equal(bp.validate(clip()).ok, true, why(clip()));
        const cases = [
            [(d) => { d.rules = { level: 'full' }; }, '/rules/budget'],
            [(d) => { d.hands.tools.push({ tool: 'shell:rm', mode: 'allow' }); }, '/hands/tools/4/tool'],
            [(d) => { d.knows.instructions = 'Post in {{room}}'; }, '/knows/instructions'],
            [(d) => { d.hands.tools.push({ tool: 'machine:shell', mode: 'ask' }); }, '/places/order'],
            [(d) => { d.hands.tools.push({ tool: 'robot:drive', mode: 'ask' }); d.places = { order: ['own'] }; }, '/places/needs'],
            [(d) => { d.places = { order: ['shared'] }; }, '/places/needs'],
            [(d) => { d.places = { order: ['desk-pc'] }; }, '/places/order'],
            [(d) => { d.makes.serve = { mcp: true }; }, '/makes/schema'],
            [(d) => { d.team = { play: 'grader-loop', roles: { doer: `${d.id}@2` } }; }, '/team/roles/doer'],
            [(d) => { d.team = { play: 'grader-loop', roles: { doer: 'bp_other' } }; }, '/team/roles/doer'],
            [(d) => { delete d.published_at; }, '/published_at'],
            [(d) => { d.when = [{ kind: 'schedule' }]; }, '/when/0/cron'],
            [(d) => { d.brain = { pick: 'exact' }; }, '/brain/model'],
        ];
        for (const [mut, at] of cases) {
            const d = clip(); mut(d);
            const v = bp.validate(d);
            assert.equal(v.ok, false, `${at} should be refused`);
            assert.ok(v.errors.some((e) => e.at === at), `${at}: got ${why(d)}`);
        }
    }],
    ['a blueprint carries no secret: anything that looks like a key or a token is refused where it is', () => {
        for (const s of ['sk-proj-abcdefghijklmnop1234', 'ghp_' + 'a'.repeat(36), 'AKIA' + 'B'.repeat(16), '-----BEGIN OPENSSH PRIVATE KEY-----']) {
            const d = clip(); d.knows.instructions = `Use ${s} to sign in.`;
            const v = bp.validate(d);
            assert.ok(v.errors.some((e) => e.at === '/knows/instructions' && /secret/.test(e.why)), s.slice(0, 6));
        }
        const d = clip(); d.hands.tools.push({ tool: 'mcp:https://tools.example.org/mcp', mode: 'ask', note: 'Bearer ' + 'x'.repeat(8) });
        assert.equal(bp.validate(d).ok, true, 'a plain note is fine');
    }],
    ['defaults are the safe ones: talks only, asks first, keeps nothing, owner only, a small budget', () => {
        const d = bp.withDefaults({ id: 'bp_tiny', version: 1, state: 'draft', name: 'Tiny', summary: 'x', author: { type: 'user', id: 'usr_1' }, visibility: 'private', knows: { instructions: 'Hi' } });
        assert.deepEqual(d.places.order, ['none']);
        assert.equal(d.rules.level, 'ask');
        assert.equal(d.memory.scope, 'none');
        assert.deepEqual(d.rules.who, { may: 'owner' });
        assert.deepEqual(d.rules.budget, { run_usd: 0.25, day_usd: 2 });
        assert.deepEqual(d.makes.serve, { a2a: false, mcp: false });
        assert.equal(d.brain.pick, 'auto');
    }],
    ['asks: the install screen in words, each with a key for agreed', () => {
        const a = bp.asks(clip());
        const byKey = Object.fromEntries(a.map((x) => [x.key, x]));
        assert.equal(byKey['hands:ov:live.chat.post'].words, 'uses live: chat post (asks you first each time)');
        assert.equal(byKey['hands:ov:live.chat.post'].ask, true);
        assert.equal(byKey['hands:ov:media.clip.create'].words, 'uses media: clip create');
        assert.equal(byKey['memory:person'].words, 'remembers what it learns about your work for 30 days');
        assert.equal(byKey['rules:level:auto-edits'].words, 'edits and runs its own work without asking');
        assert.equal(byKey['rules:budget:0.05/0.5'].words, 'spends at most 5¢ a run and 50¢ a day');
        assert.equal(byKey['when:event:live.stream.started'].words, 'starts when live.stream.started happens');
        const nicer = bp.asks(clip(), { describe: (t) => (t === 'ov:live.chat.post' ? 'your stream chat (posting)' : null) });
        assert.equal(nicer.find((x) => x.key === 'hands:ov:live.chat.post').words, 'uses your stream chat (posting) (asks you first each time)');
        for (const x of a) assert.match(x.key, /^[a-z]+:[^\s]{1,1900}$/, 'agreed keys fit agents.install@1');
        assert.deepEqual(bp.unagreed(clip(), a.map((x) => x.key)), []);
        assert.deepEqual(bp.unagreed(clip(), a.slice(1).map((x) => x.key)).map((x) => x.key), [a[0].key]);
    }],
    ['wider: only a version that asks for more waits for a yes', () => {
        assert.deepEqual(bp.wider(clip(), clip()), []);
        const fewer = clip(); fewer.hands.tools.pop(); fewer.rules.budget.day_usd = 0.2; fewer.memory.keep_days = 7;
        assert.deepEqual(bp.wider(clip(), fewer), [], 'less is not wider');
        const keys = (mut) => { const d = clip(); mut(d); return bp.wider(clip(), d).map((x) => x.key); };
        assert.deepEqual(keys((d) => { d.hands.tools.push({ tool: 'ov:community.post.create', mode: 'ask' }); }), ['hands:ov:community.post.create']);
        assert.deepEqual(keys((d) => { d.hands.tools[3].mode = 'allow'; }), ['hands:ov:live.chat.post']);
        assert.match(bp.wider(clip(), Object.assign(clip(), { hands: { tools: clip().hands.tools.map((t) => ({ ...t, mode: 'allow' })) } }))[0].words, /without asking first$/);
        assert.deepEqual(keys((d) => { d.rules.level = 'full'; }), ['rules:level:full']);
        assert.deepEqual(keys((d) => { d.rules.who = { may: 'anyone' }; }), ['rules:who:anyone']);
        assert.deepEqual(keys((d) => { d.rules.budget.day_usd = 5; }), ['rules:budget:0.05/5']);
        assert.deepEqual(keys((d) => { d.memory.keep_days = null; }), ['memory:person']);
        assert.deepEqual(keys((d) => { d.places = { order: ['none', 'own'], needs: ['gpu'] }; }), ['places:own']);
        assert.deepEqual(keys((d) => { d.when.push({ kind: 'schedule', cron: '0 9 * * *' }); }), ['when:schedule']);
        assert.deepEqual(keys((d) => { d.makes.serve.a2a = true; }), ['makes:a2a']);
    }],
    ['fill: inputs typed, checked and put in place', () => {
        const d = bp.fill(clip(), { channel: 'maticus' });
        assert.equal(d.knows.instructions, 'You watch maticus\'s stream. Clip what chat reacts to.');
        assert.equal(d.when[0].where.id, 'maticus');
        assert.throws(() => bp.fill(clip(), {}), (e) => e instanceof bp.BlueprintError && e.errors[0].why === 'Your channel is needed');
        assert.throws(() => bp.fill(clip(), { channel: 'x', city: 'Paris' }), /not one of its inputs/);
        const c = clip(); c.inputs.push({ id: 'style', type: 'choice', label: 'Style', choices: ['short', 'full'], default: 'short' });
        c.knows.instructions += ' Names are {{style}}.';
        assert.match(bp.fill(c, { channel: 'm' }).knows.instructions, /Names are short\.$/);
        assert.throws(() => bp.fill(c, { channel: 'm', style: 'long' }), /one of short, full/);
    }],
    ['compile: an installed agent runs with its own modes; a Try it run asks for every tool and spends at most 5¢', () => {
        const r = bp.compile(clip(), { install, text: 'Find tonight\'s moments' });
        assert.equal(r.start.agent, install.agent);
        assert.equal(r.start.blueprint, undefined);
        assert.deepEqual(r.start.budget, { usd: 0.05 });
        assert.deepEqual(r.loop.tools.map((t) => t.mode), ['allow', 'allow', 'allow', 'ask']);
        assert.match(r.loop.system, /^You watch maticus's stream/);
        assert.match(r.loop.system, /How you talk: Short and cheerful\./);
        assert.match(r.loop.system, /Always ask the person first before spending money, a password, deleting anything, a new recipient, and posting in your name/);
        assert.deepEqual(r.dispatch.need, { caps: ['tools'] });
        assert.equal(r.dispatch.maxPrice, 1);
        assert.deepEqual(r.place.machines, { own: ['dev_desk'], shared: [] });
        assert.equal(r.memory.scope, 'person');

        const t = bp.compile(clip(), { inputs: { channel: 'maticus' }, text: 'Try', tryIt: true });
        assert.equal(t.start.blueprint, 'bp_01JD8C4QJ7Z3K9W2X5V6N1M0PA@3');
        assert.equal(t.start.agent, undefined);
        assert.ok(t.loop.tools.every((x) => x.mode === 'ask'));
        const big = clip(); big.rules.budget.run_usd = 3;
        assert.deepEqual(bp.compile(big, { inputs: { channel: 'm' }, tryIt: true }).start.budget, { usd: 0.05 });
        const bad = clip(); bad.rules = { level: 'full' };
        assert.throws(() => bp.compile(bad, { install }), bp.BlueprintError);
    }],
    ['estimate: the cheapest choice it may use, the price of a run, where it is free', () => {
        const C = [
            { id: 'credits:big', rung: 'credits', tier: 'strong', caps: ['tools', 'vision'], price: { in: 3, out: 15 } },
            { id: 'credits:cheap', rung: 'credits', tier: 'medium', caps: ['tools', 'json'], price: { in: 0.28, out: 0.42 } },
            { id: 'machine:qwen', rung: 'machine', tier: 'small', caps: ['tools'] },
        ];
        const e = bp.estimate(clip(), C);
        assert.equal(e.choice.id, 'machine:qwen');
        assert.equal(e.usd_per_run, 0);
        assert.deepEqual(e.free_on, ['machine']);
        const noMachine = clip(); noMachine.brain.rungs = ['credits'];
        const e2 = bp.estimate(noMachine, C);
        assert.equal(e2.choice.id, 'credits:cheap', 'credits:big costs more per million than it may pay');
        assert.equal(e2.usd_per_run, Math.round(((0.28 * 2000 + 0.42 * 800) / 1e6) * 4 * 1e6) / 1e6);
        const exact = clip(); exact.brain = { pick: 'exact', model: 'credits:big' };
        assert.equal(bp.estimate(exact, C).choice.id, 'credits:big');
        const none = clip(); none.brain.rungs = ['plan'];
        assert.equal(bp.estimate(none, C).usd_per_run, null);
    }],
    ['refs: a version\'s address, and back', () => {
        assert.equal(bp.ref(clip()), 'bp_01JD8C4QJ7Z3K9W2X5V6N1M0PA@3');
        assert.deepEqual(bp.parseRef('bp_vibe@12'), { id: 'bp_vibe', version: 12 });
        assert.equal(bp.parseRef('bp_vibe'), null);
        assert.equal(bp.toolWords('machine:desk'), 'a private desk on its machine');
        assert.equal(bp.toolWords('mcp:https://tools.example.org/mcp'), 'your own tool server at tools.example.org');
    }],
]);
