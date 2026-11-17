'use strict';
/**
 * openvibe-sdk/agents/group — a conversation of people and agents in one thread (plan §AD.19; the owner, 2026-11-17:
 * "use .actor and .codes in a group conversation mode … modular sdk and API").
 *
 * What the research says (2026-11-17): a single agent with more tools matches a team on most tasks at a fraction of the
 * tokens, so a group is something people choose; explicit addressing and handoffs beat an LLM picking the next speaker
 * (that costs a model call per turn and gives a different path for the same words); every group needs hard limits.
 * So this module decides who answers by rules a person can predict, and stops on its own:
 *
 *   - a person's message goes to the agents it @mentions (in the order written; @all for every agent); with none, to
 *     the group's lead, or to the coding agent when the words are plainly about code and one is a member;
 *   - an agent hands off by @mentioning another agent (never itself); with no mention its turn ends the round;
 *   - at most `maxAgentTurns` agent messages answer one person message (3), within `budgetUsd` (0.50), and an agent
 *     that ends with DONE closes the round;
 *   - review cycles (plan §AD.25, the owner, 11-17: "have claude code work on the code and interface and then have muse
 *     and codex or API analyze and review the gui and critique it"): when a group has reviewers (`reviewer: true`, such
 *     as Design, or Codex or Muse as critics), a builder's DONE does not close the round. Every reviewer but the builder
 *     looks at the work at once (`parallel: true`) and ends with APPROVED, or with a CHANGES line and a numbered list.
 *     The last verdict in sends the builder back to fix (it ends with DONE again, and the reviewers look again), or
 *     closes the round when all approved. At most `maxReviewCycles` (2) reviews, each with its own turns, and the
 *     round's budget rises to `reviewBudgetUsd` (1.50) once a review has started. A builder hands over with a note
 *     before DONE (0.184.0: where to see it, what it started from, changed, checked and did not). A reviewer judges with a fresh eye
 *     (0.182.0): its transcript is the request, the builder's latest result and its own last verdict, never the other
 *     reviewers' critiques.
 *
 *   mentions(text, members)                 → member ids @mentioned, in order, each once (handle or name; @all)
 *   next({ message, members, history, policy })
 *                                           → { speakers: [ids], why, parallel?, review?, fix?, approved? } for the
 *                                             message just posted (parallel: the speakers may answer at once)
 *   verdict(text)                           → 'approved' | 'changes' | null: a reviewer's last word
 *   reviewState({ history, members })       → { builder, cycles, panel, answered, waiting, asks }: the round's review
 *   limits({ history, members, policy })    → { ok, turns, usd, why }: may another agent speak this round
 *   isDone(text)                            → an agent closed the round (DONE as its last word)
 *   transcript({ history, member, members, files, last })
 *                                           → the words an agent is given: who said what since it last spoke, the
 *                                             group's files, how to hand off and how to finish
 *
 * member: { id, kind: 'person' | 'agent', name, handle?, lead?, coder?, reviewer? }   (handle defaults to the id)
 * message: { from, fromKind: 'person' | 'agent', text, usd? }   history: messages in order, oldest first
 */

const POLICY = Object.freeze({ maxAgentTurns: 3, budgetUsd: 0.5, transcriptLast: 30, maxReviewCycles: 2, reviewBudgetUsd: 1.5, review: true });
const CODE_WORDS = /\b(code|coding|repo|repository|bug|stack ?trace|function|refactor|compile|deploy|pull request|PR|commit|branch|merge|unit test|tests?|typescript|javascript|python|golang|rust|npm|pnpm|git|lint|build fails?|exception|null pointer|endpoint|migration|schema)\b/i;
const DONE = /(?:^|\s)DONE[.!]?\s*$/;
// A reviewer's verdict: APPROVED as its last word, or a line that starts with CHANGES (then what to fix).
const APPROVED = /(?:^|\s)APPROVED[.!]?\s*$/;
const CHANGES = /(?:^|\n)\s*(?:\*\*)?CHANGES\b/;

const lower = (s) => String(s == null ? '' : s).toLowerCase();
const handleOf = (m) => lower(m.handle || m.id).replace(/[^a-z0-9_.-]/g, '');
const agents = (members) => (Array.isArray(members) ? members : []).filter((m) => m && m.kind === 'agent');
const reviewers = (members) => agents(members).filter((m) => m.reviewer);
const policyOf = (p) => ({ ...POLICY, ...(p && typeof p === 'object' ? p : {}) });

function mentions(text, members) {
    const t = String(text || '');
    const list = Array.isArray(members) ? members : [];
    const out = [];
    const re = /(^|[^\w@])@([A-Za-z0-9_.-]{1,40})/g;
    let m;
    while ((m = re.exec(t))) {
        const word = lower(m[2]).replace(/[.]+$/, '');
        if (word === 'all' || word === 'everyone') {
            for (const a of agents(list)) if (!out.includes(a.id)) out.push(a.id);
            continue;
        }
        const hit = list.find((x) => x && (handleOf(x) === word || lower(x.name).replace(/\s+/g, '') === word));
        if (hit && !out.includes(hit.id)) out.push(hit.id);
    }
    return out;
}

const isDone = (text) => DONE.test(String(text || ''));
/** A reviewer's last word: 'approved', 'changes' (a CHANGES line), or null when it said neither. */
function verdict(text) {
    const t = String(text || '').trim();
    if (APPROVED.test(t)) return 'approved';
    if (CHANGES.test(t)) return 'changes';
    return null;
}

/** The messages since the last person spoke (the current round), oldest first. */
function round(history) {
    const h = Array.isArray(history) ? history : [];
    let i = h.length - 1;
    while (i >= 0 && !(h[i] && h[i].fromKind === 'person')) i--;
    return h.slice(i + 1);
}

/**
 * The round's review: the builder (the last agent that is no reviewer and said DONE with reviewers to look), how many
 * reviews have started (one per such DONE), the panel (every reviewer but the builder), who of it has answered since the
 * builder's last DONE, who it waits for, and the reviewers whose last answer asked for changes (a CHANGES line).
 */
function reviewState({ history, members } = {}) {
    const rev = reviewers(members);
    const isRev = (id) => rev.some((a) => a.id === id);
    let builder = null, cycles = 0, since = [];
    for (const m of round(history)) {
        if (!m || m.fromKind === 'person') continue;
        if (!isRev(m.from) && isDone(m.text) && rev.some((a) => a.id !== m.from)) { builder = m.from; cycles += 1; since = []; }
        else if (builder && isRev(m.from) && m.from !== builder) since.push(m);
    }
    const panel = builder ? rev.filter((a) => a.id !== builder).map((a) => a.id) : [];
    const answered = panel.filter((id) => since.some((m) => m.from === id));
    const last = (id) => since.filter((m) => m.from === id).slice(-1)[0];
    return {
        builder, cycles, panel, answered,
        waiting: panel.filter((id) => !answered.includes(id)),
        // Only a CHANGES line sends the builder back: a turn that failed or said neither holds nothing up.
        asks: answered.filter((id) => verdict(last(id).text) === 'changes'),
    };
}

function limits({ history, members, policy } = {}) {
    const p = policyOf(policy);
    const r = round(history);
    const turns = r.length;
    const usd = r.reduce((n, x) => n + (Number(x && x.usd) || 0), 0);
    const last = r[r.length - 1];
    const panelSize = reviewers(members).length;
    const st = p.review !== false && panelSize ? reviewState({ history, members }) : { cycles: 0, builder: null, waiting: [] };
    const reviewing = st.cycles > 0 && st.cycles <= p.maxReviewCycles;
    // A builder's DONE that a review follows, or a review still waiting for verdicts, does not close the round.
    const open = reviewing && last && (last.from === st.builder || st.waiting.length > 0 || st.asks.length > 0);
    if (last && isDone(last.text) && !open) return { ok: false, turns, usd, why: 'the last agent said DONE' };
    const most = p.maxAgentTurns + (panelSize ? p.maxReviewCycles * (panelSize + 1) : 0);
    const cap = st.cycles > 0 ? most : p.maxAgentTurns;
    if (turns >= cap) return { ok: false, turns, usd, why: `${turns} agent turns answered this message (the most is ${cap})` };
    const budget = st.cycles > 0 ? Math.max(p.budgetUsd, p.reviewBudgetUsd) : p.budgetUsd;
    if (usd >= budget) return { ok: false, turns, usd, why: `this round spent $${usd.toFixed(2)} of $${budget.toFixed(2)}` };
    return { ok: true, turns, usd, why: 'within the limits' };
}

function next({ message, members, history, policy } = {}) {
    const list = Array.isArray(members) ? members : [];
    const at = (ids) => ids.map((id) => `@${handleOf(list.find((m) => m && m.id === id) || { id })}`).join(', ');
    const all = agents(list);
    if (!message || !all.length) return { speakers: [], why: 'no agent in the group' };
    const from = list.find((m) => m && m.id === message.from);
    const named = mentions(message.text, list).filter((id) => all.some((a) => a.id === id) && id !== message.from);
    if (!from || from.kind === 'person') {
        if (named.length) return { speakers: named, why: at(named) };
        const coder = all.find((a) => a.coder);
        if (coder && CODE_WORDS.test(String(message.text || ''))) return { speakers: [coder.id], why: 'the words are about code' };
        const lead = all.find((a) => a.lead) || all[0];
        return { speakers: [lead.id], why: `${lead.name || lead.id} leads the group` };
    }
    // An agent spoke. The history Network passes already holds the message; a caller's may not.
    const h0 = Array.isArray(history) ? history : [];
    const h = h0.some((x) => x && x.from === message.from && x.text === message.text) ? h0 : h0.concat([{ ...message, fromKind: 'agent' }]);
    const p = policyOf(policy);
    const rev = reviewers(list);
    if (p.review !== false && rev.length) {
        const fromReviewer = rev.some((a) => a.id === message.from);
        const st = reviewState({ history: h, members: list });
        // A builder said DONE: the reviewers look, all at once.
        if (!fromReviewer && isDone(message.text) && st.builder === message.from && st.panel.length) {
            if (st.cycles > p.maxReviewCycles) return { speakers: [], why: `the reviewers looked ${p.maxReviewCycles} times` };
            return { speakers: st.panel, why: `review ${st.cycles} of ${p.maxReviewCycles}`, parallel: true, review: st.cycles };
        }
        // A reviewer's verdict in a review: the last one in decides.
        if (fromReviewer && st.builder && st.panel.includes(message.from) && st.cycles <= p.maxReviewCycles) {
            if (st.waiting.length) return { speakers: [], why: `waiting for ${at(st.waiting)}`, review: st.cycles };
            if (!st.asks.length) return { speakers: [], why: 'every reviewer approved', approved: true, review: st.cycles };
            if (st.cycles >= p.maxReviewCycles) return { speakers: [], why: `${at(st.asks)} still asked for changes after ${st.cycles} reviews`, review: st.cycles };
            const room = limits({ history: h, members: list, policy });
            if (!room.ok) return { speakers: [], why: room.why };
            return { speakers: [st.builder], why: `${at(st.asks)} asked for changes`, fix: true, review: st.cycles };
        }
    }
    // A handoff when it names another agent and the round has room.
    if (isDone(message.text)) return { speakers: [], why: 'DONE' };
    if (!named.length) return { speakers: [], why: 'no handoff' };
    const room = limits({ history: h, members: list, policy });
    if (!room.ok) return { speakers: [], why: room.why };
    return { speakers: named.slice(0, Math.max(0, p.maxAgentTurns - room.turns)), why: `handed to ${at(named)}` };
}

function transcript({ history, member, members, files, last } = {}) {
    const list = Array.isArray(members) ? members : [];
    const me = list.find((m) => m && m.id === member) || { id: member, name: member };
    const h = Array.isArray(history) ? history : [];
    let since = -1;
    for (let i = h.length - 1; i >= 0; i--) if (h[i] && h[i].from === me.id) { since = i; break; }
    const n = Number(last) > 0 ? Number(last) : POLICY.transcriptLast;
    const fresh = h.slice(since + 1).slice(-n);
    const name = (id) => { const m = list.find((x) => x && x.id === id); return m ? (m.name || m.id) : id; };
    const others = agents(list).filter((a) => a.id !== me.id).map((a) => `@${handleOf(a)} (${a.name || a.id})`);
    const people = list.filter((m) => m && m.kind === 'person').map((m) => m.name || m.id);
    const head = `You are ${me.name || me.id} in a group conversation with ${people.join(', ') || 'people'}${others.length ? ` and the agents ${others.join(', ')}` : ''}.`;
    // A fresh eye (0.182.0; the owner sent Stageshow, 11-17, whose reviewer gets the result and never the builder's
    // plan): a reviewer in a review is given the person's request, the builder's latest result and its own last
    // verdict, never the other reviewers' critiques, so each judges on its own and none anchors on another.
    const rv0 = me.reviewer ? reviewState({ history: h, members: list }) : null;
    const freshEye = !!(rv0 && rv0.builder && rv0.panel.includes(me.id));
    let lines;
    if (freshEye) {
        const r = round(h);
        const all = h.slice(0, h.length - r.length);
        const asked = all[all.length - 1];
        let built = null, mine = null;
        for (const x of r) {
            if (x && x.from === rv0.builder && isDone(x.text)) built = x;
            if (x && x.from === me.id) mine = x;
        }
        lines = [head,
            ...(asked ? ['The request:', `[${name(asked.from)}]: ${String(asked.text || '').slice(0, 4000)}`] : []),
            ...(built ? ['', 'What was made:', `[${name(built.from)}]: ${String(built.text || '').slice(0, 8000)}`] : []),
            ...(mine ? ['', 'Your last review of it:', String(mine.text || '').slice(0, 4000)] : []),
        ];
    } else {
        lines = [head,
            since >= 0 ? 'Since you last spoke:' : 'The conversation so far:',
            ...fresh.map((x) => `[${name(x.from)}]: ${String(x.text || '').slice(0, 4000)}`),
        ];
    }
    const f = (Array.isArray(files) ? files : []).filter((x) => x && (x.name || x.url));
    if (f.length) lines.push('', 'Files in the group\'s shared space:', ...f.slice(0, 30).map((x) => `- ${x.name || 'A file'}${x.url ? `: ${x.url}` : ''}`));
    const rev = reviewers(list);
    const st = rev.length ? reviewState({ history: h, members: list }) : null;
    const name1 = (id) => `@${handleOf(list.find((x) => x && x.id === id) || { id })}`;
    if (me.reviewer && st && st.builder && st.panel.includes(me.id)) {
        lines.push('', `You are reviewing ${name1(st.builder)}'s work (review ${st.cycles} of ${POLICY.maxReviewCycles} at most). Judge the result, not the reasons: look at what it made, its files and links, and the pages themselves (open, audit or capture them when you can). Say what works, then what does not, the thing that spoils the most first, each with its evidence and the fix in one line, and say what you could not check. Do not fix it yourself.`,
            'End with APPROVED as your last word when it is ready, or start a line with CHANGES followed by a numbered list of what to fix, the most important first.');
    } else if (me.reviewer) {
        lines.push('', `Answer as ${me.name || me.id}. When you review something, end with APPROVED, or a CHANGES line and a numbered list of what to fix. When the request is fully answered, end your message with DONE.`);
    } else {
        lines.push('', `Answer as ${me.name || me.id}. To hand part of the work to another agent, @mention it with what you need${others.length ? ` (${others.join(', ')})` : ''}. When the request is fully answered, end your message with DONE.`);
        const panel = rev.filter((a) => a.id !== me.id);
        if (panel.length) {
            lines.push(`When you end with DONE, the reviewers (${panel.map((a) => `@${handleOf(a)}`).join(', ')}) look at your work${st && st.builder === me.id && st.asks.length ? '' : ' and may ask for changes'}.`);
            // A hand-over note (0.184.0; the Stageshow lessons, 11-17): what the reviewers need to judge the work itself.
            lines.push('Before DONE, hand over in a few lines: where to see it (a link, a file or a preview), what you started from, what you changed, what you checked and what you did not check.');
            if (st && st.builder === me.id && st.asks.length) lines.push(`They asked for changes above: fix each numbered point you agree with, say which you leave and why, then end with DONE again.`);
        }
    }
    return lines.join('\n');
}

module.exports = { POLICY, CODE_WORDS, mentions, next, limits, isDone, verdict, reviewState, transcript, round };
