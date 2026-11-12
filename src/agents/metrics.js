'use strict';
/**
 * openvibe-sdk/agents/metrics — what a run measured (agents.run@1 1.4.0 `metrics`; one-system-v2.md §4).
 *
 *   createRecorder({ now })   → { call(usage), step(), evidence(e), end(exit) → metrics, snapshot() }
 *   passAtK(results, k)       → the chance at least one of k tries passes (unbiased, from n tries with c passing)
 *   passHatK(results, k)      → the chance all k tries pass (pass^k)
 *   flakeRate(runs)           → the share of cases whose tries disagree
 *
 * Charged first, estimate never (browser-use): a call's cost is the provider's charge when it says one; an estimate
 * counts only for calls that were not charged, and is reported apart; nothing known is null, never 0.
 */

const EXITS = ['done', 'limits', 'timeout', 'format_error', 'refused', 'tool_error', 'stopped', 'error'];
const EVIDENCE = ['test', 'schema', 'grader', 'person', 'decision'];
const round = (n) => Math.round(n * 1e6) / 1e6;

function createRecorder({ now = () => Date.now() } = {}) {
    const started = now();
    let charged = null; let estimated = null;
    let tin = 0; let tout = 0; let cr = 0; let cw = 0; let steps = 0;
    const evidence = [];
    let exit = null; let ended = null;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    const api = {
        call(u = {}) {
            tin += n(u.tokens_in); tout += n(u.tokens_out); cr += n(u.cache_read); cw += n(u.cache_write);
            if (u.charged_usd != null && Number.isFinite(Number(u.charged_usd))) charged = (charged || 0) + Number(u.charged_usd);
            else if (u.estimated_usd != null && Number.isFinite(Number(u.estimated_usd))) estimated = (estimated || 0) + Number(u.estimated_usd);
            return api;
        },
        step() { steps += 1; return api; },
        evidence(e = {}) {
            if (!EVIDENCE.includes(e.kind) || typeof e.passed !== 'boolean') throw new TypeError('evidence is { kind: test|schema|grader|person|decision, passed }');
            const item = { kind: e.kind, passed: e.passed };
            if (e.detail) item.detail = String(e.detail).slice(0, 500);
            if (typeof e.probability === 'number') item.probability = Math.max(0, Math.min(1, e.probability));
            if (evidence.length < 20) evidence.push(item);
            return api;
        },
        end(how = 'done') {
            exit = EXITS.includes(how) ? how : 'error';
            ended = now();
            return api.snapshot();
        },
        snapshot() {
            return {
                charged_usd: charged == null ? null : round(charged), estimated_usd: estimated == null ? null : round(estimated),
                tokens_in: tin, tokens_out: tout, cache_read: cr, cache_write: cw,
                latency_ms: Math.max(0, (ended || now()) - started), steps,
                ...(exit ? { exit } : {}), evidence: evidence.slice(),
            };
        },
    };
    return api;
}

/** Unbiased pass@k from n tries with c passing (Chen et al., HumanEval): 1 - C(n-c, k) / C(n, k). */
function passAtK(results, k) {
    const r = Array.isArray(results) ? results : [];
    const n = r.length; const c = r.filter(Boolean).length;
    if (!n || k < 1) return null;
    if (n - c < k) return 1;
    let p = 1;
    for (let i = n - c + 1; i <= n; i++) p *= 1 - k / i;
    return round(1 - p);
}
/** pass^k: the chance that k independent tries all pass, from the observed pass rate. */
function passHatK(results, k) {
    const r = Array.isArray(results) ? results : [];
    if (!r.length || k < 1) return null;
    return round((r.filter(Boolean).length / r.length) ** k);
}
/** The share of cases whose tries do not all agree. CASES is [[true, false, true], …]. */
function flakeRate(cases) {
    const cs = (Array.isArray(cases) ? cases : []).filter((c) => Array.isArray(c) && c.length > 1);
    if (!cs.length) return null;
    return round(cs.filter((c) => c.some(Boolean) && !c.every(Boolean)).length / cs.length);
}

module.exports = { createRecorder, passAtK, passHatK, flakeRate, EXITS, EVIDENCE };
