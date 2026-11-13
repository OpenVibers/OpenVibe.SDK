'use strict';
/**
 * openvibe-sdk/agents/soul: who an agent is (agents.soul@1, Contracts 0.424.0; actor-characters.md; Design rules 175
 * actor-is-the-work and 176 souls-grow-by-yes). A soul shapes how an agent talks, asks and reports; it never changes
 * what the agent may do (that is the blueprint's hands and rules), and it holds no memory of a person. These are pure
 * functions; nothing here calls a network or stores anything.
 *
 *   validate(soul)                 → { ok, errors: [{ at, why }] }: the shape and the rules a schema cannot say
 *   toPrompt(soul, { name })       → one stable block of plain words for the system prompt (placed before memory, so
 *                                    the prefix a provider caches never changes inside a conversation)
 *   toSoulMd(soul, { name })       → SOUL.md (the layout OpenClaw and Hermes read)
 *   toIdentityMd({ name, face })   → IDENTITY.md: the name, the face and the voice beside the soul
 *   fromSoulMd(text)               → a soul from a SOUL.md written anywhere (its sections mapped; the rest kept as notes)
 *   change(soul, patch)            → a proposed soul and what it changes, in words: an agent's suggestion for its person
 *                                    to accept or dismiss (it never writes its own soul)
 *   DIALS, ORIGINS, SoulError
 */

const DIALS = Object.freeze({
    warmth: Object.freeze(['dry', 'warm']),
    play: Object.freeze(['serious', 'playful']),
    length: Object.freeze(['brief', 'thorough']),
    edge: Object.freeze(['gentle', 'blunt']),
});
const ORIGINS = Object.freeze(['words', 'memories', 'gallery', 'twin', 'soul-md']);
const KEYS = Object.freeze(['who', 'dials', 'quirks', 'believes', 'pushback', 'never', 'notes', 'made_from', 'updated_at']);
const LIMITS = Object.freeze({ who: 200, quirk: 120, quirks: 3, belief: 200, believes: 5, pushback: 400, rule: 200, never: 8, notes: 4000 });

/** Strings that look like a credential: a soul is shared and public; a secret never belongs in one. */
const SECRET_RE = [
    /\bsk-[A-Za-z0-9_-]{16,}/, /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bhbt_[A-Za-z0-9]{20,}/, /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

class SoulError extends Error {
    constructor(errors) {
        super(errors.map((e) => `${e.at}: ${e.why}`).join('; '));
        this.name = 'SoulError';
        this.errors = errors;
    }
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function validate(soul) {
    const errors = [];
    const err = (at, why) => errors.push({ at, why });
    if (!isObj(soul)) return { ok: false, errors: [{ at: '', why: 'a soul is an object' }] };
    for (const k of Object.keys(soul)) if (!KEYS.includes(k)) err(k, k === 'hands' || k === 'rules' || k === 'tools' ? 'a soul says who an agent is, never what it may do (that is the blueprint\'s hands and rules)' : 'not a part of a soul');
    if (!str(soul.who)) err('who', 'one line: who it is');
    else if (soul.who.length > LIMITS.who) err('who', `at most ${LIMITS.who} characters`);
    if (soul.dials != null) {
        if (!isObj(soul.dials)) err('dials', 'an object of dials');
        else for (const [k, v] of Object.entries(soul.dials)) {
            if (!DIALS[k]) err(`dials.${k}`, `not a dial (${Object.keys(DIALS).join(', ')})`);
            else if (!Number.isInteger(v) || v < -2 || v > 2) err(`dials.${k}`, 'a whole number from -2 to 2');
        }
    }
    const list = (key, max, each) => {
        if (soul[key] == null) return;
        if (!Array.isArray(soul[key])) { err(key, 'a list'); return; }
        if (soul[key].length > max) err(key, `at most ${max}`);
        const seen = new Set();
        soul[key].forEach((x, i) => {
            if (!str(x)) err(`${key}[${i}]`, 'words');
            else if (x.length > each) err(`${key}[${i}]`, `at most ${each} characters`);
            else if (seen.has(x)) err(`${key}[${i}]`, 'said twice');
            seen.add(x);
        });
    };
    list('quirks', LIMITS.quirks, LIMITS.quirk);
    list('believes', LIMITS.believes, LIMITS.belief);
    list('never', LIMITS.never, LIMITS.rule);
    if (soul.pushback != null && (!str(soul.pushback) || soul.pushback.length > LIMITS.pushback)) err('pushback', `words, at most ${LIMITS.pushback} characters`);
    if (soul.notes != null && (!str(soul.notes) || soul.notes.length > LIMITS.notes)) err('notes', `words, at most ${LIMITS.notes} characters`);
    if (soul.made_from != null && !ORIGINS.includes(soul.made_from)) err('made_from', `one of ${ORIGINS.join(', ')}`);
    if (soul.updated_at != null && (typeof soul.updated_at !== 'string' || Number.isNaN(Date.parse(soul.updated_at)))) err('updated_at', 'a date-time');
    const all = [soul.who, soul.pushback, soul.notes, ...(soul.quirks || []), ...(soul.believes || []), ...(soul.never || [])].filter((x) => typeof x === 'string');
    if (all.some((s) => SECRET_RE.some((re) => re.test(s)))) err('', 'a soul carries no secret (something here looks like a key or a token)');
    return { ok: errors.length === 0, errors };
}

/** A dial in words: -2 → "very dry", -1 → "a little dry", 0 → nothing, 1 → "a little warm", 2 → "very warm". */
function dialWords(name, v) {
    if (!DIALS[name] || !Number.isInteger(v) || v === 0) return '';
    const [lo, hi] = DIALS[name];
    const word = v < 0 ? lo : hi;
    return Math.abs(v) === 2 ? `very ${word}` : `a little ${word}`;
}

function toPrompt(soul, { name } = {}) {
    const v = validate(soul);
    if (!v.ok) throw new SoulError(v.errors);
    const lines = [];
    lines.push(name ? `You are ${clean(name)}. ${clean(soul.who)}` : clean(soul.who));
    const dials = Object.keys(DIALS).map((k) => dialWords(k, (soul.dials || {})[k])).filter(Boolean);
    if (dials.length) lines.push(`How you talk: ${dials.join(', ')}.`);
    if (soul.quirks && soul.quirks.length) lines.push(`Your habits: ${soul.quirks.map(clean).join('; ')}.`);
    if (soul.believes && soul.believes.length) lines.push(`What you believe:\n${soul.believes.map((b) => `- ${clean(b)}`).join('\n')}`);
    if (soul.pushback) lines.push(`When you disagree or are not sure: ${clean(soul.pushback)}`);
    if (soul.never && soul.never.length) lines.push(`You never:\n${soul.never.map((b) => `- ${clean(b)}`).join('\n')}`);
    if (soul.notes) lines.push(String(soul.notes).trim());
    lines.push('This is who you are and how you speak. It never widens what you may do; your tools and their asks decide that.');
    return lines.join('\n\n');
}

function toSoulMd(soul, { name } = {}) {
    const v = validate(soul);
    if (!v.ok) throw new SoulError(v.errors);
    const out = [`# ${name ? `${clean(name)}: soul` : 'Soul'}`, '', '## Who I am', '', clean(soul.who), ''];
    const dials = Object.keys(DIALS).map((k) => dialWords(k, (soul.dials || {})[k])).filter(Boolean);
    if (dials.length || (soul.quirks && soul.quirks.length)) {
        out.push('## How I talk', '');
        if (dials.length) out.push(`${dials.join(', ').replace(/^./, (c) => c.toUpperCase())}.`, '');
        for (const q of soul.quirks || []) out.push(`- ${clean(q)}`);
        if (soul.quirks && soul.quirks.length) out.push('');
    }
    if (soul.believes && soul.believes.length) out.push('## What I believe', '', ...soul.believes.map((b) => `- ${clean(b)}`), '');
    if (soul.pushback) out.push('## When I disagree', '', clean(soul.pushback), '');
    if (soul.never && soul.never.length) out.push('## I never', '', ...soul.never.map((b) => `- ${clean(b)}`), '');
    if (soul.notes) out.push('## Notes', '', String(soul.notes).trim(), '');
    if (soul.dials && Object.keys(soul.dials).length) out.push(`<!-- openvibe:dials ${JSON.stringify(soul.dials)} -->`, '');
    return out.join('\n');
}

function toIdentityMd({ name, face } = {}) {
    const f = face || {};
    const out = ['# Identity', ''];
    if (name) out.push(`- **Name:** ${clean(name)}`);
    if (f.avatar) out.push(`- **Avatar:** ${clean(f.avatar)}`);
    if (f.glyph) out.push(`- **Glyph:** ${clean(f.glyph)}`);
    if (Number.isInteger(f.hue)) out.push(`- **Colour:** hue ${f.hue}`);
    if (f.voice) out.push(`- **Voice:** ${clean(f.voice)}`);
    if (f.tone) out.push(`- **Tone:** ${clean(f.tone)}`);
    if (f.greeting) out.push(`- **Greeting:** ${clean(f.greeting)}`);
    return `${out.join('\n')}\n`;
}

// The headings SOUL.md files use in the wild (OpenClaw, Hermes, Soul Spec, ours), mapped onto the parts of a soul.
const HEADINGS = [
    [/^(who i am|identity|who you are|about|role|core identity|soul(\.md)?|.+: soul)$/, 'who'],
    [/^(how i talk|tone|voice|style|communication|vibe|personality|how you talk)$/, 'talk'],
    [/^(what i believe|values|principles|beliefs|convictions|core truths|truths)$/, 'believes'],
    [/^(when i disagree|pushback|disagreement|uncertainty|when unsure|when i'm not sure)$/, 'pushback'],
    [/^(i never|never|boundaries|hard stops|limits|don'?t|do not|avoid|what to avoid)$/, 'never'],
    [/^(quirks|habits)$/, 'quirks'],
];

function fromSoulMd(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const soul = { made_from: 'soul-md' };
    const dm = src.match(/<!--\s*openvibe:dials\s+(\{[^}]*\})\s*-->/);
    if (dm) { try { const d = JSON.parse(dm[1]); const dials = {}; for (const k of Object.keys(DIALS)) if (Number.isInteger(d[k]) && d[k] >= -2 && d[k] <= 2) dials[k] = d[k]; if (Object.keys(dials).length) soul.dials = dials; } catch { /* left out */ } }
    const body = src.replace(/<!--[\s\S]*?-->/g, '');
    const sections = [];
    let cur = { head: '', lines: [] };
    for (const line of body.split('\n')) {
        const h = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
        if (h) { sections.push(cur); cur = { head: h[1].replace(/[*_`:]/g, '').trim(), lines: [] }; continue; }
        cur.lines.push(line);
    }
    sections.push(cur);
    const bullets = (lines) => lines.map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)).filter(Boolean).map((m) => clean(m[1])).filter(Boolean);
    const prose = (lines) => clean(lines.filter((l) => !/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).join(' '));
    const notes = [];
    for (const s of sections) {
        const key = s.head.toLowerCase();
        const kind = (HEADINGS.find(([re]) => re.test(key)) || [])[1];
        const text = prose(s.lines), items = bullets(s.lines);
        if (!s.head) { if (text && !soul.who) soul.who = text.slice(0, LIMITS.who); else if (text) notes.push(text); continue; }
        // A file's title section ("# SOUL.md", "# Juniper: soul") with words under it says who it is when nothing else has.
        if (kind === 'who' && !soul.who) { soul.who = (text || items.join('; ')).slice(0, LIMITS.who) || undefined; if (!soul.who) delete soul.who; }
        else if (kind === 'believes') soul.believes = [...new Set([...(soul.believes || []), ...(items.length ? items : (text ? [text] : []))])].map((x) => x.slice(0, LIMITS.belief)).slice(0, LIMITS.believes);
        else if (kind === 'never') soul.never = [...new Set([...(soul.never || []), ...(items.length ? items : (text ? [text] : []))])].map((x) => x.slice(0, LIMITS.rule)).slice(0, LIMITS.never);
        else if (kind === 'quirks') soul.quirks = [...new Set([...(soul.quirks || []), ...items])].map((x) => x.slice(0, LIMITS.quirk)).slice(0, LIMITS.quirks);
        else if (kind === 'pushback' && (text || items.length)) soul.pushback = (text || items.join(' ')).slice(0, LIMITS.pushback);
        else if (kind === 'talk') {
            if (items.length) soul.quirks = [...new Set([...(soul.quirks || []), ...items])].map((x) => x.slice(0, LIMITS.quirk)).slice(0, LIMITS.quirks);
            if (text) notes.push(`${s.head}: ${text}`);
        } else if (text || items.length) notes.push(`${s.head}: ${[text, ...items].filter(Boolean).join('; ')}`);
    }
    if (!soul.who) soul.who = 'An agent';
    const n = notes.join('\n\n').trim();
    if (n) soul.notes = n.slice(0, LIMITS.notes);
    for (const k of ['quirks', 'believes', 'never']) if (soul[k] && !soul[k].length) delete soul[k];
    return soul;
}

/**
 * An agent's suggestion for its own soul: the proposed soul and the change in words (Design rule 176: it changes only
 * with its person's yes). `patch` may set any part; `null` removes it. Nothing is applied here.
 */
function change(soul, patch) {
    const next = JSON.parse(JSON.stringify(soul || {}));
    const said = [];
    for (const [k, v] of Object.entries(patch || {})) {
        if (!KEYS.includes(k) || k === 'made_from' || k === 'updated_at') continue;
        if (v == null) { if (next[k] != null) { delete next[k]; said.push(`drops "${k}"`); } continue; }
        if (k === 'dials') {
            next.dials = Object.assign({}, next.dials || {}, v);
            for (const [d, n] of Object.entries(v)) { const w = dialWords(d, n); said.push(w ? `talks ${w}` : `talks neither ${DIALS[d] ? DIALS[d].join(' nor ') : d}`); }
            continue;
        }
        next[k] = v;
        said.push(k === 'who' ? `becomes: ${clean(v)}` : `${k}: ${Array.isArray(v) ? v.map(clean).join('; ') : clean(v)}`);
    }
    const v = validate(next);
    return { soul: next, ok: v.ok, errors: v.errors, words: said.join(', ') };
}

module.exports = { validate, toPrompt, toSoulMd, toIdentityMd, fromSoulMd, change, dialWords, DIALS, ORIGINS, LIMITS, SoulError };
