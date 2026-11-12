'use strict';
/**
 * openvibe-sdk/agents/dispatch — the Dispatcher (agent-engine.md §3): for each step, not just each run, which model,
 * which harness and which place. Pure functions over the choices a person has (Exchange's offers merged with their
 * own machines, plans and keys); nothing here calls a network.
 *
 *   ladder(choices, { need, pin, avoid, budgetLeft })   → the choices that can do the step, cheapest rung first
 *   pick(choices, options)                             → the first of them (or null), with why
 *   escalate(current, evidence, choices, options)      → a stronger choice, only on checkable evidence
 *   harnessFor(task, harnesses, { plans })             → the harness by capability, never by name
 *   placeFor(run, { machines, cloud })                 → where the work lives
 *   estimate(choice, { tokensIn, tokensOut })          → the price of a turn in USD
 *   slice(parentBudget, share)                         → a child's budget, a slice of its parent's
 *
 * A choice: { id, name, rung: 'machine' | 'plan' | 'key' | 'allowance' | 'credits', family, tier: 'small' | 'medium' |
 * 'strong', caps: ['tools', 'vision', 'json', 'thinking', 'long-context', …], context (tokens), speed (tokens a
 * second), price: { in, out } (USD per million tokens; a rung that is not paid per token has none), available }.
 *
 * The rules, in the order they apply: a person's own pick always wins when it can do the step (and is only passed over,
 * with a reason, when it cannot); a choice that lacks a needed capability, a large enough context or the speed asked
 * for is never offered; then the ladder: the person's own machine (free), a signed-in plan through its harness (flat),
 * their own key (no fee), the free allowance, then Exchange's credits, cheapest first inside a rung; a smaller tier is
 * tried before a stronger one inside a rung unless the step says it needs strength. A step is redone on a stronger model
 * only when something checkable failed: a test, a schema, a tool error, a grader (of another family), or the model's
 * own structured "not sure"; never on a hunch.
 */

const RUNGS = ['machine', 'plan', 'key', 'allowance', 'credits'];
const TIERS = ['small', 'medium', 'strong'];
const EVIDENCE = ['test', 'schema', 'tool', 'grader', 'unsure'];

const rungOf = (c) => (RUNGS.includes(c && c.rung) ? RUNGS.indexOf(c.rung) : RUNGS.length);
const tierOf = (c) => (TIERS.includes(c && c.tier) ? TIERS.indexOf(c.tier) : 1);
const caps = (c) => new Set(Array.isArray(c && c.caps) ? c.caps : []);

/** The price of one turn of `choice`, in USD (0 on a rung that is not paid per token). */
function estimate(choice, { tokensIn = 0, tokensOut = 0 } = {}) {
    const p = choice && choice.price;
    if (!p || (p.in == null && p.out == null)) return 0;
    return Math.round((((Number(p.in) || 0) * tokensIn + (Number(p.out) || 0) * tokensOut) / 1e6) * 1e6) / 1e6;
}

/** Why a choice cannot do the step, or null when it can. */
function cannot(c, need = {}) {
    if (!c || c.available === false) return 'not available now';
    const have = caps(c);
    for (const cap of Array.isArray(need.caps) ? need.caps : []) if (!have.has(cap)) return `cannot ${cap}`;
    if (need.context && (Number(c.context) || 0) < need.context) return `holds ${c.context || 0} tokens, the step needs ${need.context}`;
    if (need.speed && (Number(c.speed) || 0) < need.speed) return `writes ${c.speed || 0} tokens a second, the step needs ${need.speed}`;
    if (need.tier && tierOf(c) < TIERS.indexOf(need.tier)) return `a ${c.tier || 'medium'} model, the step needs ${need.tier}`;
    return null;
}

/**
 * The choices that can do the step, in the order the Dispatcher tries them, each with `why` (the rung, or the person's
 * pick). Choices that cannot are listed in `.skipped` with the reason (the picker shows them greyed, with it).
 */
function ladder(choices, { need = {}, pin = null, avoid = [], budgetLeft = null, tokens = { tokensIn: 2000, tokensOut: 800 } } = {}) {
    const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
    const skipped = [];
    const ok = [];
    const avoidSet = new Set(Array.isArray(avoid) ? avoid : []);
    for (const c of list) {
        const why = cannot(c, need) || (avoidSet.has(c.family) ? `a ${c.family} model, and this step asks for another family` : null)
            || (budgetLeft != null && estimate(c, tokens) > budgetLeft ? 'costs more than the budget has left' : null);
        if (why) skipped.push({ choice: c, why }); else ok.push(c);
    }
    const strongFirst = need.tier === 'strong';
    ok.sort((a, b) => rungOf(a) - rungOf(b)
        || (strongFirst ? tierOf(b) - tierOf(a) : tierOf(a) - tierOf(b))
        || estimate(a, tokens) - estimate(b, tokens)
        || String(a.id).localeCompare(String(b.id)));
    let out = ok.map((c) => ({ ...c, why: c.rung || 'credits' }));
    if (pin) {
        const pinned = out.find((c) => c.id === pin);
        if (pinned) out = [{ ...pinned, why: 'your pick' }, ...out.filter((c) => c.id !== pin)];
        else { const s = skipped.find((x) => x.choice.id === pin); if (s) s.pinned = true; }
    }
    out.skipped = skipped;
    return out;
}

/** The first choice the ladder offers, or null with the reasons nothing could. */
function pick(choices, options = {}) {
    const l = ladder(choices, options);
    const pinSkipped = l.skipped.find((s) => s.pinned);
    return { choice: l[0] || null, why: l[0] ? l[0].why : 'no model can do this step', passedOver: pinSkipped ? { id: pinSkipped.choice.id, why: pinSkipped.why } : null, skipped: l.skipped };
}

/**
 * A stronger choice after a checkable failure. `evidence` is { kind: 'test' | 'schema' | 'tool' | 'grader' | 'unsure',
 * detail }; anything else (a hunch, a long answer, a slow one) returns null. The next choice is the cheapest that can do
 * the step at a higher tier than `current`; a grader's failure also avoids the current family. `tried` lists the ids
 * already used on this step.
 */
function escalate(current, evidence, choices, { need = {}, tried = [], budgetLeft = null } = {}) {
    if (!evidence || !EVIDENCE.includes(evidence.kind)) return null;
    const higher = TIERS[Math.min(TIERS.length - 1, tierOf(current) + 1)];
    if (tierOf(current) >= TIERS.length - 1 && evidence.kind !== 'grader') return null;
    const avoid = evidence.kind === 'grader' && current && current.family ? [current.family] : [];
    const used = new Set([current && current.id, ...(Array.isArray(tried) ? tried : [])].filter(Boolean));
    // At the top tier only a grader's failure moves, and then to another family at the same strength.
    const l = ladder((choices || []).filter((c) => !used.has(c.id)), { need: { ...need, tier: higher }, avoid, budgetLeft });
    return l[0] ? { choice: l[0], why: `${evidence.kind === 'unsure' ? 'it was not sure' : `a ${evidence.kind} failed`}${evidence.detail ? `: ${String(evidence.detail).slice(0, 200)}` : ''}` } : null;
}

/**
 * The harness for a task by what it must do: chat and ask turns with product tools run on the light loop on a server;
 * work with files and commands on dsh by default, or on a harness whose plan the person signed in (their Codex, their
 * Claude Code) when it can do the work. A harness: { id, caps: [...], plan?: string }.
 */
function harnessFor(task = {}, harnesses = [], { plans = [] } = {}) {
    const needs = Array.isArray(task.needs) ? task.needs : [];
    const list = Array.isArray(harnesses) ? harnesses : [];
    const can = (h) => needs.every((n) => (h.caps || []).includes(n));
    if (!needs.some((n) => ['files', 'shell', 'desks', 'browser'].includes(n))) {
        const loop = list.find((h) => h.id === 'loop' && can(h));
        if (loop) return { harness: loop, why: 'a turn with tools runs on the light loop' };
    }
    const signed = list.find((h) => h.plan && plans.includes(h.plan) && can(h));
    if (signed) return { harness: signed, why: `your ${signed.plan} plan` };
    const dsh = list.find((h) => h.id === 'dsh' && can(h));
    if (dsh) return { harness: dsh, why: 'the default for work with files and commands' };
    const any = list.find(can);
    return any ? { harness: any, why: 'it can do what the task needs' } : null;
}

/**
 * Where the work lives. A repository on the person's computer → that computer (Link's worker); a site to click through
 * → a private desk on their machine, else an OpenVibe computer; heavy or untrusted code → a sandbox; a robot → Bot;
 * a conversation → OpenVibe's servers. `machines`: the person's online machines with what their grants allow
 * ({ id, name, online, allows: ['worker', 'desks', 'models'], repos: [...] }). `cloud`: whether OpenVibe's computers
 * may be used (and paid for).
 */
function placeFor(run = {}, { machines = [], cloud = true } = {}) {
    const online = (Array.isArray(machines) ? machines : []).filter((m) => m && m.online);
    const repo = run.target && typeof run.target === 'object' ? run.target.repo : null;
    if (run.robot) return { where: { kind: 'machine', id: run.robot }, why: 'a robot is reached through Bot' };
    if (repo) {
        const m = online.find((x) => (x.allows || []).includes('worker') && (x.repos || []).includes(repo));
        if (m) return { where: { kind: 'machine', id: m.id, name: m.name }, why: 'the repository is on your computer' };
        return { where: { kind: 'runner' }, why: 'a Codes runner checks it out' };
    }
    if (run.needs && run.needs.includes('browser')) {
        const m = online.find((x) => (x.allows || []).includes('desks'));
        if (m) return { where: { kind: 'machine', id: m.id, name: m.name }, why: 'a private desk on your computer (free)' };
        if (cloud) return { where: { kind: 'openvibe' }, why: 'an OpenVibe computer' };
        return null;
    }
    if (run.untrusted || run.heavy) return cloud ? { where: { kind: 'openvibe' }, why: 'heavy or untrusted work runs in a sandbox' } : null;
    return { where: { kind: 'openvibe' }, why: 'a conversation runs on OpenVibe' };
}

/** A child's budget: `share` (0..1) of what the parent has left, field by field; absent fields stay unlimited. */
function slice(parent, share) {
    const s = Math.max(0, Math.min(1, Number(share) || 0));
    const out = {};
    if (!parent || typeof parent !== 'object') return out;
    if (parent.usd != null) out.usd = Math.round(parent.usd * s * 1e6) / 1e6;
    if (parent.tokens != null) out.tokens = Math.floor(parent.tokens * s);
    if (parent.seconds != null) out.seconds = Math.floor(parent.seconds * s);
    if (parent.steps != null) out.steps = Math.max(1, Math.floor(parent.steps * s));
    return out;
}

module.exports = { ladder, pick, escalate, harnessFor, placeFor, estimate, slice, cannot, RUNGS, TIERS, EVIDENCE };
