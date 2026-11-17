'use strict';
// openvibe-sdk/agents/group: who answers in a group of people and agents, and when a round stops (plan §AD.19).
const assert = require('node:assert/strict');
const g = require('../src/agents/group');

const members = [
    { id: 'usr_alex', kind: 'person', name: 'Alex' },
    { id: 'actor', kind: 'agent', name: 'Actor', lead: true },
    { id: 'codes', kind: 'agent', name: 'Codes', coder: true },
];
const say = (from, text, usd) => ({ from, fromKind: from.startsWith('usr_') ? 'person' : 'agent', text, ...(usd != null ? { usd } : {}) });

// Mentions: handle or name, in order, each once; @all is every agent; e-mail addresses are not mentions.
assert.deepEqual(g.mentions('@codes look, then @Actor sums up, @codes again', members), ['codes', 'actor']);
assert.deepEqual(g.mentions('@all what do you think?', members), ['actor', 'codes']);
assert.deepEqual(g.mentions('mail me at alex@openvibe.network', members), []);

// A person's message: the @mentioned agents; else Codes for plainly coding words; else the lead.
assert.deepEqual(g.next({ message: say('usr_alex', '@codes fix the build'), members }).speakers, ['codes']);
assert.deepEqual(g.next({ message: say('usr_alex', 'there is a bug in the upload endpoint'), members }).speakers, ['codes']);
assert.deepEqual(g.next({ message: say('usr_alex', 'plan my week'), members }).speakers, ['actor']);
assert.match(g.next({ message: say('usr_alex', 'plan my week'), members }).why, /Actor leads/);

// An agent hands off by @mention, never to itself; no mention or DONE ends the round.
const h1 = [say('usr_alex', 'plan the launch'), say('actor', '@codes can you check the deploy script?')];
assert.deepEqual(g.next({ message: h1[1], members, history: h1 }).speakers, ['codes']);
const h2 = [...h1, say('codes', 'Checked: it is fine. @codes')];
assert.deepEqual(g.next({ message: h2[2], members, history: h2 }).speakers, [], 'not to itself');
const h3 = [...h1, say('codes', 'All good, nothing to change. DONE')];
assert.deepEqual(g.next({ message: h3[2], members, history: h3 }), { speakers: [], why: 'DONE' });

// Limits: three agent turns per person message, a budget, and DONE.
const busy = [say('usr_alex', 'go'), say('actor', '@codes', 0.01), say('codes', '@actor', 0.01), say('actor', '@codes', 0.01)];
assert.deepEqual([g.limits({ history: busy }).ok, g.limits({ history: busy }).turns], [false, 3]);
assert.deepEqual(g.next({ message: busy[3], members, history: busy }).speakers, [], 'the round is full');
assert.equal(g.limits({ history: [say('usr_alex', 'go'), say('actor', 'spent', 0.6)] }).ok, false, 'over budget');
assert.equal(g.limits({ history: [say('usr_alex', 'go'), say('actor', 'ok', 0.01)], policy: { maxAgentTurns: 5 } }).ok, true);
assert.equal(g.isDone('That is it. DONE'), true);
assert.equal(g.isDone('DONE with step one, now step two'), false);

// The transcript: what the agent has not seen, the shared space, how to hand off and finish.
const hist = [say('usr_alex', 'make a logo'), say('actor', 'Here is a draft. @codes put it in the repo'), say('usr_alex', 'make it blue')];
const t = g.transcript({ history: hist, member: 'codes', members, files: [{ name: 'logo.svg', url: 'https://openvibe.media/o/med_1' }] });
assert.match(t, /^You are Codes in a group conversation with Alex and the agents @actor \(Actor\)\./);
assert.match(t, /\[Alex\]: make a logo\n\[Actor\]: Here is a draft\. @codes put it in the repo\n\[Alex\]: make it blue/);
assert.match(t, /- logo\.svg: https:\/\/openvibe\.media\/o\/med_1/);
assert.match(t, /end your message with DONE\.$/);
const after = [...hist, say('codes', 'Done in the repo.'), say('usr_alex', 'thanks')];
assert.match(g.transcript({ history: after, member: 'codes', members }), /Since you last spoke:\n\[Alex\]: thanks\n/, 'only what it has not seen');

// Review cycles (plan §AD.25; the owner, 11-17: "have claude code work on the code and interface and then have muse and
// codex or API analyze and review the gui and critique it"). Codes builds; Design and Codex review.
const room = [...members, { id: 'design', kind: 'agent', name: 'Design', reviewer: true }, { id: 'codex', kind: 'agent', name: 'Codex review', reviewer: true }];
assert.equal(g.verdict('Looks right on a phone and a desktop.\nAPPROVED'), 'approved');
assert.equal(g.verdict('Two problems.\nCHANGES\n1. The sheet sticks out at 390 px.\n2. The tabs are 36 px tall.'), 'changes');
assert.equal(g.verdict('**CHANGES**\n1. Contrast'), 'changes');
assert.equal(g.verdict('I think it is fine'), null);

// The builder's DONE: both reviewers at once, and the round stays open for them.
const r1 = [say('usr_alex', '@codes build the usage sheet'), say('codes', 'Built it: https://openvibe.live/x. DONE', 0.2)];
let nx = g.next({ message: r1[1], members: room, history: r1 });
assert.deepEqual([nx.speakers, nx.parallel, nx.review], [['design', 'codex'], true, 1], 'the reviewers look, in parallel');
assert.equal(g.limits({ history: r1, members: room }).ok, true, 'a DONE a review follows does not close the round');
assert.equal(g.limits({ history: r1 }).ok, false, 'without the members (an older caller) DONE still closes it');
assert.deepEqual(g.reviewState({ history: r1, members: room }), { builder: 'codes', cycles: 1, panel: ['design', 'codex'], answered: [], waiting: ['design', 'codex'], asks: [] });

// One verdict in: wait for the other. Then one asks for changes: the builder fixes.
const r2 = [...r1, say('design', 'The gauges are full width.\nCHANGES\n1. Draw each gauge to its share.', 0.05)];
nx = g.next({ message: r2[2], members: room, history: r2 });
assert.deepEqual([nx.speakers, nx.why], [[], 'waiting for @codex']);
assert.equal(g.limits({ history: r2, members: room }).ok, true, 'still open while a verdict is missing');
const r3 = [...r2, say('codex', 'Code reads fine.\nAPPROVED', 0.03)];
nx = g.next({ message: r3[3], members: room, history: r3 });
assert.deepEqual([nx.speakers, nx.fix, nx.why], [['codes'], true, '@design asked for changes'], 'back to the builder');
// Parallel answers: the history already holds both; asking for either verdict gives the same answer.
assert.deepEqual(g.next({ message: r3[2], members: room, history: r3 }).speakers, ['codes']);
const tf = g.transcript({ history: r3, member: 'codes', members: room });
assert.match(tf, /They asked for changes above: fix each numbered point you agree with/);
const tr = g.transcript({ history: r1, member: 'design', members: room });
assert.match(tr, /You are reviewing @codes's work \(review 1 of 2 at most\)/);
assert.match(tr, /End with APPROVED as your last word when it is ready, or start a line with CHANGES/);
assert.match(g.transcript({ history: [say('usr_alex', 'build it')], member: 'codes', members: room }), /When you end with DONE, the reviewers \(@design, @codex\) look at your work and may ask for changes\./);

// The fix, DONE again: the second review. Both approve: the round closes.
const r4 = [...r3, say('codes', 'Fixed the gauges. DONE', 0.1)];
nx = g.next({ message: r4[4], members: room, history: r4 });
assert.deepEqual([nx.speakers, nx.review], [['design', 'codex'], 2]);
const r5 = [...r4, say('design', 'Right now.\nAPPROVED'), say('codex', 'APPROVED')];
nx = g.next({ message: r5[6], members: room, history: r5 });
assert.deepEqual([nx.speakers, nx.approved, nx.why], [[], true, 'every reviewer approved']);
assert.equal(g.limits({ history: r5, members: room }).ok, true, 'limits leave the closing to next()');

// Two reviews at most: still changes after the second closes the round and says who.
const r6 = [...r4, say('design', 'CHANGES\n1. Still too wide'), say('codex', 'APPROVED')];
nx = g.next({ message: r6[6], members: room, history: r6 });
assert.deepEqual([nx.speakers, nx.why], [[], '@design still asked for changes after 2 reviews']);
const r7 = [...r6, say('codes', 'One more fix. DONE')];
assert.deepEqual(g.next({ message: r7[7], members: room, history: r7 }).speakers, [], 'no third review');

// A review has its own turns and a higher budget: 3 + 2 × (2 reviewers + 1) = 9 turns, $1.50.
const long = [say('usr_alex', 'build'), ...Array.from({ length: 8 }, (_, i) => say(i === 0 ? 'codes' : 'design', i === 0 ? 'x DONE' : 'CHANGES\n1. y', 0.01))];
assert.equal(g.limits({ history: long, members: room }).ok, true);
assert.match(g.limits({ history: [...long, say('codex', 'APPROVED')], members: room }).why, /the most is 9/);
const dear = [say('usr_alex', 'build'), say('codes', 'x DONE', 1.2)];
assert.equal(g.limits({ history: dear, members: room }).ok, true, '$1.20 is within a review\'s $1.50');
assert.match(g.limits({ history: [...dear, say('design', 'CHANGES\n1. z', 0.4)], members: room }).why, /of \$1\.50/);

// Reasons name members by handle, as people write them (Network's ids are agent:<handle>).
const ids = [{ id: 'usr:alex', kind: 'person', name: 'Alex' }, { id: 'agent:codes', kind: 'agent', name: 'Codes', handle: 'codes', coder: true }, { id: 'agent:design', kind: 'agent', name: 'Design', handle: 'design', reviewer: true }];
const q = [say('usr:alex', '@codes build it'), { from: 'agent:codes', fromKind: 'agent', text: 'Built. DONE' }, { from: 'agent:design', fromKind: 'agent', text: 'CHANGES\n1. Wider gutters' }];
assert.equal(g.next({ message: q[0], members: ids, history: q.slice(0, 1) }).why, '@codes');
assert.equal(g.next({ message: q[2], members: ids, history: q }).why, '@design asked for changes');

// Only a CHANGES line sends the builder back: a reviewer whose turn failed, or that said neither, holds nothing up.
const r8 = [...r1, say('design', 'Could not answer: the run failed'), say('codex', 'Reads fine to me.')];
assert.deepStrictEqual(g.next({ message: r8[3], members: room, history: r8 }), { speakers: [], why: 'every reviewer approved', approved: true, review: 1 });

// A reviewer is never its own reviewer, and a group without reviewers keeps the old rules; review: false turns it off.
const solo = [say('usr_alex', '@design make an icon'), say('design', 'Here it is. DONE')];
assert.deepEqual(g.next({ message: solo[1], members: room, history: solo }), { speakers: [], why: 'DONE' }, 'a reviewer\'s own DONE closes');
assert.deepEqual(g.next({ message: r1[1], members, history: r1 }), { speakers: [], why: 'DONE' }, 'no reviewers: DONE closes');
assert.deepEqual(g.next({ message: r1[1], members: room, history: r1, policy: { review: false } }), { speakers: [], why: 'DONE' }, 'review off');

console.log('agents-group: mentions, who answers, handoffs, limits, the transcript, and review cycles');
