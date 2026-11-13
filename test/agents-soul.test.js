'use strict';
// openvibe-sdk/agents/soul: who an agent is (agents.soul@1, Contracts 0.424.0). The souls here mirror Contracts'
// fixtures (a producer, just a who, one from a SOUL.md) and the invalid ones (a dial past two, six beliefs, no who, an
// unknown origin, a permission in the soul).
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const soul = require('../src/agents/soul');

const producer = () => ({
    who: 'A dry, fast producer who keeps your stream on time',
    dials: { warmth: -1, play: 1, length: -2, edge: 1 },
    quirks: ['Counts down the last minute before you go live'],
    believes: ['A late start costs more viewers than a rough one', 'Chat is the show too'],
    pushback: 'Says so once, plainly, with the reason, then does it your way.',
    never: ['Talks over a guest'],
    made_from: 'memories',
});

run([
    ['valid souls pass; each invalid one names its part', () => {
        assert.deepEqual(soul.validate(producer()), { ok: true, errors: [] });
        assert.ok(soul.validate({ who: 'Your patient study partner' }).ok);
        assert.ok(soul.validate({ who: 'A careful reviewer', notes: 'I read the whole diff first.', made_from: 'soul-md', updated_at: '2026-11-13T06:40:00Z' }).ok);
        const at = (s) => soul.validate(s).errors.map((e) => e.at);
        assert.deepEqual(at({ who: 'Loud', dials: { edge: 3 } }), ['dials.edge']);
        assert.deepEqual(at({ who: 'Opinionated', believes: ['a', 'b', 'c', 'd', 'e', 'f'] }), ['believes']);
        assert.deepEqual(at({ pushback: 'Argues.' }), ['who']);
        assert.deepEqual(at({ who: 'Someone', made_from: 'scraped' }), ['made_from']);
        const perm = soul.validate({ who: 'Helpful', hands: [{ tool: 'ov:live.chat.post', mode: 'allow' }] });
        assert.deepEqual(perm.errors.map((e) => e.at), ['hands']);
        assert.match(perm.errors[0].why, /never what it may do/);
        assert.deepEqual(at({ who: 'Leaky', notes: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz' }), ['']);
        assert.deepEqual(at({ who: 'Twice', never: ['Swears', 'Swears'] }), ['never[1]']);
    }],
    ['toPrompt is one stable block of plain words', () => {
        const p = soul.toPrompt(producer(), { name: 'Juniper' });
        assert.ok(p.startsWith('You are Juniper. A dry, fast producer who keeps your stream on time'));
        assert.ok(p.includes('How you talk: a little dry, a little playful, very brief, a little blunt.'));
        assert.ok(p.includes('What you believe:\n- A late start costs more viewers than a rough one\n- Chat is the show too'));
        assert.ok(p.includes('You never:\n- Talks over a guest'));
        assert.ok(p.endsWith('It never widens what you may do; your tools and their asks decide that.'));
        assert.equal(soul.toPrompt(producer(), { name: 'Juniper' }), p, 'the same soul gives the same prefix');
        assert.throws(() => soul.toPrompt({ who: '' }), soul.SoulError);
        assert.equal(soul.dialWords('warmth', 0), '');
        assert.equal(soul.dialWords('edge', -2), 'very gentle');
    }],
    ['SOUL.md out and back keeps the soul', () => {
        const md = soul.toSoulMd(producer(), { name: 'Juniper' });
        assert.ok(md.startsWith('# Juniper: soul\n\n## Who I am\n\nA dry, fast producer'));
        assert.ok(md.includes('## What I believe') && md.includes('## When I disagree') && md.includes('## I never'));
        const back = soul.fromSoulMd(md);
        assert.equal(back.who, producer().who);
        assert.deepEqual(back.dials, producer().dials);
        assert.deepEqual(back.believes, producer().believes);
        assert.deepEqual(back.never, producer().never);
        assert.deepEqual(back.quirks, producer().quirks);
        assert.equal(back.pushback, producer().pushback);
        assert.equal(back.made_from, 'soul-md');
        assert.ok(soul.validate(back).ok);
    }],
    ['a SOUL.md from elsewhere maps its sections, and keeps the rest as notes', () => {
        const other = '# SOUL.md\n\nI am a calm research partner.\n\n## Core Truths\n\n- Evidence before opinions\n- Say what you do not know\n\n## Boundaries\n\n- Never invent a citation\n\n## Vibe\n\nWarm but direct; short paragraphs.\n\n## Continuity\n\nEach session starts fresh; files are my memory.\n';
        const s = soul.fromSoulMd(other);
        assert.equal(s.who, 'I am a calm research partner.');
        assert.deepEqual(s.believes, ['Evidence before opinions', 'Say what you do not know']);
        assert.deepEqual(s.never, ['Never invent a citation']);
        assert.ok(s.notes.includes('Vibe: Warm but direct; short paragraphs.'));
        assert.ok(s.notes.includes('Continuity: Each session starts fresh; files are my memory.'));
        assert.ok(soul.validate(s).ok);
        assert.equal(soul.fromSoulMd('').who, 'An agent', 'an empty file still gives a valid soul');
    }],
    ['IDENTITY.md carries the name, the face and the voice', () => {
        const id = soul.toIdentityMd({ name: 'Juniper', face: { avatar: 'preset:producer', hue: 30, voice: 'ov:voice:aria', greeting: 'Ten minutes to air.' } });
        assert.equal(id, '# Identity\n\n- **Name:** Juniper\n- **Avatar:** preset:producer\n- **Colour:** hue 30\n- **Voice:** ov:voice:aria\n- **Greeting:** Ten minutes to air.\n');
    }],
    ['change() proposes a new soul and says it in words; nothing is applied', () => {
        const base = producer();
        const c = soul.change(base, { dials: { length: 0 }, never: ['Talks over a guest', 'Spoils a game'] });
        assert.ok(c.ok);
        assert.deepEqual(c.soul.dials, { warmth: -1, play: 1, length: 0, edge: 1 });
        assert.equal(c.words, 'talks neither brief nor thorough, never: Talks over a guest; Spoils a game');
        assert.deepEqual(base.dials.length, -2, 'the original is untouched');
        const bad = soul.change(base, { dials: { edge: 5 } });
        assert.equal(bad.ok, false);
        assert.deepEqual(soul.change(base, { hands: ['x'], made_from: 'twin' }).words, '', 'parts a soul does not have, and its origin, are not changed');
    }],
]);
