'use strict';
/**
 * openvibe-sdk/agents/roads — which of a person's own resources runs their next turn (plan §AD.17, "the one agent route").
 *
 * Every OpenVibe agent surface asks the same question before a turn: what takes it? The answer is one order, written
 * once here, that Actor's engine walks (taking each road as it goes), the Frame answers for a page (GET
 * /api/frame/resources `road`) and the composer's road chip shows. Before this module each kept its own copy, and the
 * chip had to be changed by hand whenever Actor's order changed (Shared 4.300.0 followed Actor #575 that way).
 *
 *   1. choice     the model or provider the person picked themselves: their choice, always first
 *   2. free       OpenVibe's free AI, when today's allowance covers this turn (an agent turn takes about TURN_TOKENS;
 *                 Chat's one model, any token left). Not knowing the allowance (AI did not answer) is not a refusal
 *   3. key        an AI key of theirs they allowed this app to use (OpenVibe.AI key apps)
 *   4. computer   a computer of theirs that is online (Codes runs the turn there, on their own plans and harnesses)
 *   5. none       nothing can: the answer says why, when the free AI comes back, and the ways to add a road
 *
 * A coding run (mode 'code') is Codes' own and has no road here. Balance (paid AI) is not a road yet: it is the owner's
 * decision (H1, a person-paid task budget), and comes in as its own rung when it is made.
 *
 *   needFor(mode, { turnTokens })        → the tokens a turn in that mode needs from the free AI (chat 1, code 0)
 *   fits(allowance, need)                → { ok, known, left, why }: does today's allowance cover it
 *   pick(facts)                          → the road from facts already in hand (a page, the Frame)
 *   walk(rungs)                          → the same order, each rung a value or a function asked only when reached;
 *                                          a function may take the road (send the turn to the computer) and answer
 *                                          what it did, or null to pass. Async.
 *   say(result)                          → one sentence for the person
 *
 * facts (pick): { mode, need?, allowance, choice, keys, machines, app }
 *   allowance  { unlimited, tokens, left, resets_at } | null (unknown)
 *   choice     { provider, model? } | null
 *   keys       [{ provider, ok?, status?, apps?: [app ids it is allowed for] }]
 *   machines   [{ id, name, online, disabled? }]
 *   app        the app asking ('actor', 'chat'…): a key counts only when allowed for it (no `apps` list: any app)
 *
 * result: { road, mode, need, why, ladder: [{ road, open, why }], …the road's own fields } — `ladder` is every rung
 * considered, in order, with why it was open or closed: the receipt and the chip both say it.
 */

const ROADS = Object.freeze(['choice', 'free', 'key', 'computer']);
// What an agent turn on the free AI takes, about (Actor, 2026-11-17: two probe turns took 11,134 and 10,986 tokens).
const TURN_TOKENS = 12000;
const MODES = Object.freeze(['auto', 'agent', 'chat', 'code']);

function modeOf(mode) {
    const m = String(mode || 'auto').toLowerCase();
    return MODES.includes(m) ? m : 'auto';
}

function needFor(mode, { turnTokens = TURN_TOKENS } = {}) {
    const m = modeOf(mode);
    if (m === 'code') return 0;
    if (m === 'chat') return 1;
    const n = Number(turnTokens);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : TURN_TOKENS;
}

const short = (n) => {
    const v = Math.max(0, Math.round(Number(n) || 0));
    return v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(v);
};

function fits(allowance, need) {
    const n = Math.max(0, Number(need) || 0);
    if (!allowance || typeof allowance !== 'object') return { ok: true, known: false, left: null, why: 'the allowance is not known: the free AI is tried' };
    if (allowance.unlimited) return { ok: true, known: true, left: null, why: 'no daily cap' };
    const left = Math.max(0, Number(allowance.left) || 0);
    if (allowance.left == null && allowance.tokens == null) return { ok: true, known: false, left: null, why: 'the allowance is not known: the free AI is tried' };
    if (left >= n && left > 0) return { ok: true, known: true, left, why: `${short(left)} tokens left today` };
    if (left > 0) return { ok: false, known: true, left, why: `${short(left)} tokens left today, a turn like this takes about ${short(n)}` };
    return { ok: false, known: true, left: 0, why: 'the free allowance is used up today' };
}

const keyOk = (k) => !!k && !!k.provider && k.ok !== false && !['revoked', 'invalid', 'disabled', 'error'].includes(String(k.status || '').toLowerCase());
const keyFor = (k, app) => keyOk(k) && (!Array.isArray(k.apps) || !app || k.apps.map(String).includes(String(app)));
const machineUp = (m) => !!m && m.online === true && !m.disabled;

/** The none result's words and fields, shared by pick and walk. */
function closed(base, allowance) {
    const f = fits(allowance, base.need);
    const out = { ...base, road: 'none', left: f.left, resets_at: allowance && allowance.resets_at ? allowance.resets_at : null };
    // Some left but not enough for an agent turn: Chat's one model would still answer.
    out.chat_only = base.mode !== 'chat' && f.known && f.left > 0;
    out.why = out.chat_only ? `${f.why}: enough for Chat, not for an agent turn` : f.known ? f.why : 'no road is open';
    return out;
}

function pick(facts = {}) {
    const mode = modeOf(facts.mode);
    const need = facts.need != null ? Math.max(0, Number(facts.need) || 0) : needFor(mode);
    const base = { mode, need, ladder: [] };
    if (mode === 'code') return { ...base, road: 'code', why: 'a coding run goes to Codes, which routes it itself' };
    const ladder = base.ladder;
    const choice = facts.choice && facts.choice.provider ? facts.choice : null;
    ladder.push({ road: 'choice', open: !!choice, why: choice ? `you picked ${choice.model || choice.provider}` : 'no model picked' });
    if (choice) return { ...base, road: 'choice', provider: choice.provider, model: choice.model || null, why: ladder[0].why };
    const f = fits(facts.allowance, need);
    ladder.push({ road: 'free', open: f.ok, why: f.why });
    if (f.ok) return { ...base, road: 'free', left: f.left, known: f.known, why: f.why };
    const key = (Array.isArray(facts.keys) ? facts.keys : []).find((k) => keyFor(k, facts.app));
    ladder.push({ road: 'key', open: !!key, why: key ? `your ${key.provider} key` : 'no key allowed for this app' });
    if (key) return { ...base, road: 'key', provider: key.provider, why: `${f.why}, so your ${key.provider} key takes it` };
    const pc = (Array.isArray(facts.machines) ? facts.machines : []).find(machineUp);
    ladder.push({ road: 'computer', open: !!pc, why: pc ? `${pc.name || 'your computer'} is online` : 'no computer of yours is online' });
    if (pc) return { ...base, road: 'computer', machine: { id: pc.id == null ? null : pc.id, name: pc.name || null }, why: `${f.why}, so ${pc.name || 'your computer'} takes it` };
    return closed(base, facts.allowance);
}

const valueOf = async (rung) => (typeof rung === 'function' ? rung() : rung);

/**
 * The same order, asked lazily: rungs.allowance / choice / key / computer are values or functions (async allowed),
 * each called only when its rung is reached. key answers { provider, … } or null; computer answers what taking the
 * road gave (any truthy value: Actor's dispatched task) or null. A rung that throws is closed, with its message.
 */
async function walk(rungs = {}) {
    const mode = modeOf(rungs.mode);
    const need = rungs.need != null ? Math.max(0, Number(rungs.need) || 0) : needFor(mode);
    const base = { mode, need, ladder: [] };
    if (mode === 'code') return { ...base, road: 'code', why: 'a coding run goes to Codes, which routes it itself' };
    const ladder = base.ladder;
    const ask = async (road, rung) => {
        try { return await valueOf(rung); } catch (err) { ladder.push({ road, open: false, why: `could not be asked: ${err && err.message ? err.message : err}` }); return undefined; }
    };
    const choice = await ask('choice', rungs.choice);
    if (choice && choice.provider) {
        ladder.push({ road: 'choice', open: true, why: `you picked ${choice.model || choice.provider}` });
        return { ...base, road: 'choice', provider: choice.provider, model: choice.model || null, value: choice, why: `you picked ${choice.model || choice.provider}` };
    }
    if (choice !== undefined) ladder.push({ road: 'choice', open: false, why: 'no model picked' });
    const allowance = await ask('free', rungs.allowance);
    const f = fits(allowance === undefined ? null : allowance, need);
    ladder.push({ road: 'free', open: f.ok, why: f.why });
    if (f.ok) return { ...base, road: 'free', left: f.left, known: f.known, why: f.why };
    const key = await ask('key', rungs.key);
    if (key && key.provider) {
        ladder.push({ road: 'key', open: true, why: `your ${key.provider} key` });
        return { ...base, road: 'key', provider: key.provider, value: key, why: `${f.why}, so your ${key.provider} key takes it` };
    }
    if (key !== undefined) ladder.push({ road: 'key', open: false, why: 'no key allowed for this app' });
    const pc = await ask('computer', rungs.computer);
    if (pc) {
        ladder.push({ road: 'computer', open: true, why: 'your computer took it' });
        return { ...base, road: 'computer', value: pc, why: `${f.why}, so your computer takes it` };
    }
    if (pc !== undefined) ladder.push({ road: 'computer', open: false, why: 'no computer of yours is online' });
    return closed(base, allowance === undefined ? null : allowance);
}

/** One sentence for the person (the chip's title, a failed turn's first line). */
function say(result) {
    const r = result || {};
    switch (r.road) {
        case 'choice': return `Your pick, ${r.model || r.provider}, answers.`;
        case 'free': return r.left != null ? `OpenVibe's free AI answers (${short(r.left)} tokens left today).` : 'OpenVibe\'s free AI answers.';
        case 'key': return `Your ${r.provider} key answers: ${String(r.why || '').split(', so')[0]}.`;
        case 'computer': return `${(r.machine && r.machine.name) || 'Your computer'} answers: ${String(r.why || '').split(', so')[0]}.`;
        case 'code': return 'Codes runs it.';
        case 'none': return r.chat_only
            ? `OpenVibe's free AI has ${short(r.left)} tokens left today: enough for Chat, not for an agent turn. Add your own AI key or your computer to keep going.`
            : `OpenVibe's free AI is used up for today. Add your own AI key or your computer to keep going.`;
        default: return '';
    }
}

module.exports = { ROADS, MODES, TURN_TOKENS, needFor, fits, pick, walk, say };
