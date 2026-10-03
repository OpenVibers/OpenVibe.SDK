'use strict';
/**
 * openvibe-sdk/cost — platform.rate-card@1 and platform.cost-snapshot@1, plus estimate() for a rate card.
 * Pure construction and validation, no I/O and no dependency at require time: openvibe-contracts is required
 * lazily by the validate* functions, the way src/service re-exports its packages.
 *
 *   const { rateCard, costSnapshot, estimate, validateRateCard, validateCostSnapshot } = require('openvibe-sdk/cost');
 *   const card = rateCard({ id, provider, metric, unit_size, unit_price_usd, free_allowance, reset_period,
 *       effective_from, source, verified_at });
 *   estimate(card, 2_500_000, 'ops');   // { quantity, unit, billable, cost_usd }
 */

/** The fields platform.rate-card@1 requires or allows, in the schema's order; null/undefined are stripped. */
function rateCard(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        provider: f.provider,
        adapter: f.adapter,
        metric: f.metric,
        unit_size: f.unit_size,
        unit_price_usd: f.unit_price_usd,
        free_allowance: f.free_allowance,
        reset_period: f.reset_period,
        region: f.region,
        effective_from: f.effective_from,
        effective_until: f.effective_until,
        source: f.source,
        verified_at: f.verified_at,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** The fields platform.cost-snapshot@1 requires or allows; null/undefined are stripped. */
function costSnapshot(fields) {
    const f = fields || {};
    const record = {
        window_start: f.window_start,
        window_end: f.window_end,
        project_id: f.project_id,
        scope: f.scope,
        by_target: f.by_target,
        actual_usd: f.actual_usd,
        counterfactual_usd: f.counterfactual_usd,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/**
 * The cost of `quantity` units in one rate card: billable = max(0, quantity − free_allowance), priced in whole
 * unit_size chunks at unit_price_usd. `unit` is carried through for the caller's label; the math is unit-agnostic.
 */
function estimate(card, quantity, unit) {
    const q = Number(quantity) || 0;
    const free = Number(card.free_allowance) || 0;
    const billable = Math.max(0, q - free);
    const size = Number(card.unit_size) || 1;
    const cost_usd = (billable / size) * (Number(card.unit_price_usd) || 0);
    return { quantity: q, unit: unit || null, billable, cost_usd };
}

/** { ok, errors } for a record against platform.rate-card@1. */
function validateRateCard(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.rate-card@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

/** { ok, errors } for a record against platform.cost-snapshot@1. */
function validateCostSnapshot(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.cost-snapshot@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { rateCard, costSnapshot, estimate, validateRateCard, validateCostSnapshot };
