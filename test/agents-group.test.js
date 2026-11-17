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

console.log('agents-group: mentions, who answers, handoffs, limits and the transcript');
