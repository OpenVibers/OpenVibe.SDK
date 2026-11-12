'use strict';
/**
 * openvibe-sdk/agents/router — pay for the strong model only when it is likely to matter (one-system-v2.md §4; RouteLLM's
 * shape, Apache-2.0: route on a predicted win rate, calibrate the threshold to a budget). The prediction comes from
 * OpenVibe Decisions (POST /api/v1/decisions, a calibrated probability); this module is pure and takes the caller's
 * own function to ask it.
 *
 *   question(step)                          → the Decisions request body for one step
 *   probability(answer)                     → P(the small model is not enough) from a Decisions answer, or null
 *   route({ p, threshold, small, strong })  → { choice, strong: boolean, why }
 *   calibrate(history, { strongShare })     → the threshold that sends that share of steps to the strong model
 *   outcomes(history)                       → the quality-cost points per share (the scoreboard Exchange draws)
 *   chain(steps, { pin, ask })              → the ordered strategy (Gemini CLI): the person's pick → a pin → the router
 *
 * history is [{ p, strong, ok, usd }]: the probability seen, whether the strong model ran, whether the step succeeded by
 * checkable evidence, and what it cost.
 */

function question(step) {
    const text = String((step && (step.text || step.task)) || '').slice(0, 20000);
    return {
        input: text,
        questions: {
            needs_strong: {
                type: 'noul',
                instructions: 'Would a small, fast model most likely get this step wrong or do it badly, so that a stronger model is worth paying for? Answer yes only for hard reasoning, long or subtle code, careful judgement or a high cost of error.',
            },
        },
        prefer: 'calibrated',
    };
}

function probability(answer) {
    const a = answer && answer.answers && answer.answers.needs_strong;
    const p = a && (typeof a.probability === 'number' ? a.probability : typeof a.yes === 'number' ? a.yes : null);
    return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
}

function route({ p, threshold = 0.5, small, strong }) {
    if (p == null) return { choice: small, strong: false, why: 'no prediction: the cheaper model, escalating only on evidence' };
    const s = p >= threshold;
    return { choice: s ? strong : small, strong: s, why: `P(needs strong) ${p.toFixed(2)} ${s ? '≥' : '<'} threshold ${threshold.toFixed(2)}` };
}

/** The (1 - share) quantile of the probabilities seen: that share of steps would have gone strong. */
function calibrate(history, { strongShare = 0.2 } = {}) {
    const ps = (Array.isArray(history) ? history : []).map((h) => h && h.p).filter((p) => typeof p === 'number').sort((a, b) => a - b);
    if (!ps.length) return { threshold: 0.5, samples: 0 };
    const share = Math.max(0, Math.min(1, strongShare));
    const k = Math.round(share * ps.length);          // how many of the steps seen would have gone strong
    if (k <= 0) return { threshold: 1.000001, samples: ps.length };
    return { threshold: ps[ps.length - k], samples: ps.length };
}

/** Quality and cost at each strong share, for the steps that ran both ways or either. */
function outcomes(history, shares = [0, 0.2, 0.5, 0.8, 1]) {
    const h = (Array.isArray(history) ? history : []).filter((x) => x && typeof x.p === 'number');
    return shares.map((share) => {
        const { threshold } = calibrate(h, { strongShare: share });
        const routed = h.filter((x) => (x.p >= threshold) === !!x.strong);
        const ok = routed.filter((x) => x.ok).length;
        const usd = routed.reduce((s, x) => s + (Number(x.usd) || 0), 0);
        return { share, threshold, steps: routed.length, quality: routed.length ? ok / routed.length : null, usd_per_step: routed.length ? usd / routed.length : null };
    });
}

/** The ordered strategy: the person's own pick wins; then a pin; then the router (ASK returns a probability). */
async function chain(step, { pick = null, pin = null, ask = null, threshold = 0.5, small, strong } = {}) {
    if (pick) return { choice: pick, strong: null, why: 'the person’s own pick' };
    if (pin) return { choice: pin, strong: null, why: 'the blueprint’s pin' };
    let p = null;
    if (typeof ask === 'function') { try { p = probability(await ask(question(step))); } catch { p = null; } }
    return route({ p, threshold, small, strong });
}

module.exports = { question, probability, route, calibrate, outcomes, chain };
