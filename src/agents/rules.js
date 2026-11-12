'use strict';
/**
 * openvibe-sdk/agents/rules — permissions as data (agents.permission-rule@1; one-system-v2.md §3.1-3.3, from Gemini CLI
 * and OpenCode). Pure functions; nothing here asks a person or calls a network.
 *
 *   decide(rules, call, { attended, level })  → { effect: 'allow' | 'ask' | 'deny', rule, why }
 *   fromBlueprint(doc)                         → the rules a blueprint's hands, sandbox and network compile to
 *   matches(pattern, value)                    → a tool or resource pattern with * (and ** for paths)
 *
 * A call is { action, resource?, floor?, kind? }: ACTION a tool name (ov:live.chat.post, machine:shell), RESOURCE what it
 * touches (a path, a domain, a command line), FLOOR true for money, a password, a deletion, a new recipient or posting in
 * the person's name (the caller marks it; the floor ASKS whatever any rule says, and a deny still denies), KIND one of
 * read | edit | exec | network | other, which the level's default uses.
 *
 * Rules are read in order and the LAST one that matches wins (a person's narrow rule after a blueprint's broad one). A
 * rule's `when` limits it to attended or unattended work. With no rule matching, the level decides:
 *   ask             ask
 *   auto-edits      allow reads, edits and its own commands; ask the rest
 *   approve-for-me  allow
 *   full            allow
 * Unattended work (a schedule, a trigger, a check on a node) never waits: an ask there settles to allow at the levels
 * approve-for-me and full, and to deny below them. The floor is the exception: unattended, it is denied.
 */

const LEVELS = ['ask', 'auto-edits', 'approve-for-me', 'full'];
const EFFECTS = ['allow', 'ask', 'deny'];

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** A pattern with * (one segment or any run of characters in a name) and ** (any path), anchored. */
function toRegExp(pattern) {
    const p = String(pattern || '');
    let out = '';
    for (let i = 0; i < p.length; i++) {
        if (p[i] === '*' && p[i + 1] === '*') { out += '.*'; i++; continue; }
        if (p[i] === '*') { out += p.includes('/') ? '[^/]*' : '.*'; continue; }
        out += esc(p[i]);
    }
    return new RegExp(`^${out}$`);
}
function matches(pattern, value) {
    if (pattern == null || pattern === '' || pattern === '*') return true;
    return toRegExp(pattern).test(String(value == null ? '' : value));
}
/** A resource rule: a path glob, a domain (*.example.org matches its subdomains and itself), or a command prefix. */
function resourceMatches(rule, resource) {
    if (rule.resource == null) return true;
    const r = String(resource == null ? '' : resource);
    const pat = String(rule.resource);
    if (/^\*\.[a-z0-9.-]+$/i.test(pat)) { const base = pat.slice(2).toLowerCase(); const host = r.toLowerCase(); return host === base || host.endsWith(`.${base}`); }
    if (pat.includes('*')) return matches(pat, r);
    return r === pat || r.startsWith(`${pat} `) || r.startsWith(`${pat}/`);
}

function byLevel(level, call) {
    if (level === 'full' || level === 'approve-for-me') return 'allow';
    if (level === 'auto-edits' && ['read', 'edit', 'exec'].includes(call.kind)) return 'allow';
    return 'ask';
}

function decide(rules, call, { attended = true, level = 'ask' } = {}) {
    const lv = LEVELS.includes(level) ? level : 'ask';
    let hit = null;
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || !EFFECTS.includes(rule.effect)) continue;
        const when = rule.when || 'any';
        if ((when === 'attended' && !attended) || (when === 'unattended' && attended)) continue;
        if (matches(rule.action, call.action) && resourceMatches(rule, call.resource)) hit = rule;
    }
    let effect = hit ? hit.effect : byLevel(lv, call);
    let why = hit ? `rule ${hit.action}${hit.resource ? ` on ${hit.resource}` : ''}: ${hit.effect}` : `level ${lv}`;
    if (call.floor && effect !== 'deny') { effect = 'ask'; why = 'the floor always asks'; }
    if (!attended && effect === 'ask') {
        if (call.floor) { effect = 'deny'; why = 'the floor asks, and nobody is there to answer'; }
        else { effect = lv === 'full' || lv === 'approve-for-me' ? 'allow' : 'deny'; why += `; unattended at level ${lv}: ${effect}`; }
    }
    return { effect, rule: hit, why };
}

const MACHINE_KIND = { files: 'edit', shell: 'exec', desk: 'other', browser: 'network', screen: 'read' };
/** The rules a blueprint compiles to: each tool's mode, the sandbox's protected writes, and its network. */
function fromBlueprint(doc) {
    const out = [];
    const tools = doc && doc.hands && Array.isArray(doc.hands.tools) ? doc.hands.tools : [];
    out.push({ action: '*', effect: 'deny', reason: 'only the tools the blueprint names' });
    for (const t of tools) out.push({ action: t.tool, effect: t.mode === 'allow' ? 'allow' : 'ask' });
    if (doc && doc.hands && doc.hands.search) out.push({ action: 'tool_search', effect: 'allow' });
    const rules = (doc && doc.rules) || {};
    const sandbox = rules.sandbox || 'workspace-write';
    if (sandbox === 'read-only') out.push({ action: 'machine:files', resource: '**', effect: 'deny', reason: 'read-only' }, { action: 'machine:shell', effect: 'deny', reason: 'read-only' });
    if (sandbox !== 'full') out.push({ action: 'machine:files', resource: '**/.git/hooks/**', effect: 'deny', reason: 'never the hooks' }, { action: 'machine:files', resource: '**/.openvibe/**', effect: 'deny', reason: 'never its own config' });
    const net = rules.network || { mode: 'public' };
    if (net.mode === 'none') out.push({ action: 'network', effect: 'deny', reason: 'no network' });
    if (net.mode === 'listed') { out.push({ action: 'network', effect: 'deny', reason: 'listed domains only' }); for (const d of net.domains || []) out.push({ action: 'network', resource: d, effect: 'allow' }); }
    return out;
}

module.exports = { decide, fromBlueprint, matches, LEVELS, EFFECTS, MACHINE_KIND };
