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
 *     that ends with DONE closes the round.
 *
 *   mentions(text, members)                 → member ids @mentioned, in order, each once (handle or name; @all)
 *   next({ message, members, history, policy })
 *                                           → { speakers: [ids], why } for the message just posted
 *   limits({ history, policy })             → { ok, turns, usd, why }: may another agent speak this round
 *   isDone(text)                            → an agent closed the round (DONE as its last word)
 *   transcript({ history, member, members, files, last })
 *                                           → the words an agent is given: who said what since it last spoke, the
 *                                             group's files, how to hand off and how to finish
 *
 * member: { id, kind: 'person' | 'agent', name, handle?, lead?, coder? }   (handle defaults to the id)
 * message: { from, fromKind: 'person' | 'agent', text, usd? }   history: messages in order, oldest first
 */

const POLICY = Object.freeze({ maxAgentTurns: 3, budgetUsd: 0.5, transcriptLast: 30 });
const CODE_WORDS = /\b(code|coding|repo|repository|bug|stack ?trace|function|refactor|compile|deploy|pull request|PR|commit|branch|merge|unit test|tests?|typescript|javascript|python|golang|rust|npm|pnpm|git|lint|build fails?|exception|null pointer|endpoint|migration|schema)\b/i;
const DONE = /(?:^|\s)DONE[.!]?\s*$/;

const lower = (s) => String(s == null ? '' : s).toLowerCase();
const handleOf = (m) => lower(m.handle || m.id).replace(/[^a-z0-9_.-]/g, '');
const agents = (members) => (Array.isArray(members) ? members : []).filter((m) => m && m.kind === 'agent');
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

/** The messages since the last person spoke (the current round), oldest first. */
function round(history) {
    const h = Array.isArray(history) ? history : [];
    let i = h.length - 1;
    while (i >= 0 && !(h[i] && h[i].fromKind === 'person')) i--;
    return h.slice(i + 1);
}

function limits({ history, policy } = {}) {
    const p = policyOf(policy);
    const r = round(history);
    const turns = r.length;
    const usd = r.reduce((n, x) => n + (Number(x && x.usd) || 0), 0);
    const last = r[r.length - 1];
    if (last && isDone(last.text)) return { ok: false, turns, usd, why: 'the last agent said DONE' };
    if (turns >= p.maxAgentTurns) return { ok: false, turns, usd, why: `${turns} agent turns answered this message (the most is ${p.maxAgentTurns})` };
    if (usd >= p.budgetUsd) return { ok: false, turns, usd, why: `this round spent $${usd.toFixed(2)} of $${p.budgetUsd.toFixed(2)}` };
    return { ok: true, turns, usd, why: 'within the limits' };
}

function next({ message, members, history, policy } = {}) {
    const list = Array.isArray(members) ? members : [];
    const all = agents(list);
    if (!message || !all.length) return { speakers: [], why: 'no agent in the group' };
    const from = list.find((m) => m && m.id === message.from);
    const named = mentions(message.text, list).filter((id) => all.some((a) => a.id === id) && id !== message.from);
    if (!from || from.kind === 'person') {
        if (named.length) return { speakers: named, why: `@${named.join(', @')}` };
        const coder = all.find((a) => a.coder);
        if (coder && CODE_WORDS.test(String(message.text || ''))) return { speakers: [coder.id], why: 'the words are about code' };
        const lead = all.find((a) => a.lead) || all[0];
        return { speakers: [lead.id], why: `${lead.name || lead.id} leads the group` };
    }
    // An agent spoke: a handoff when it names another agent and the round has room.
    if (isDone(message.text)) return { speakers: [], why: 'DONE' };
    if (!named.length) return { speakers: [], why: 'no handoff' };
    const room = limits({ history, policy });
    if (!room.ok) return { speakers: [], why: room.why };
    return { speakers: named.slice(0, Math.max(0, policyOf(policy).maxAgentTurns - room.turns)), why: `handed to @${named.join(', @')}` };
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
    const lines = [
        `You are ${me.name || me.id} in a group conversation with ${people.join(', ') || 'people'}${others.length ? ` and the agents ${others.join(', ')}` : ''}.`,
        since >= 0 ? 'Since you last spoke:' : 'The conversation so far:',
        ...fresh.map((x) => `[${name(x.from)}]: ${String(x.text || '').slice(0, 4000)}`),
    ];
    const f = (Array.isArray(files) ? files : []).filter((x) => x && (x.name || x.url));
    if (f.length) lines.push('', 'Files in the group\'s shared space:', ...f.slice(0, 30).map((x) => `- ${x.name || 'A file'}${x.url ? `: ${x.url}` : ''}`));
    lines.push('', `Answer as ${me.name || me.id}. To hand part of the work to another agent, @mention it with what you need${others.length ? ` (${others.join(', ')})` : ''}. When the request is fully answered, end your message with DONE.`);
    return lines.join('\n');
}

module.exports = { POLICY, CODE_WORDS, mentions, next, limits, isDone, transcript, round };
