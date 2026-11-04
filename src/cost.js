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
 *
 * It also carries the AI Exchange money math (decision D1): integer nano-USD (1e-9 USD) with BigInt arithmetic,
 * never floats. Rates are integer nano-USD per million tokens; the charge of a component is
 * `ceil(tokens * rate_nano_per_m / 1e6)`, computed once per component per request, plus a per-request fee.
 *
 *   const { nanoUsd, chargeTokens, expectedCostNano, costPerSuccessNano } = require('openvibe-sdk/cost');
 *   const charge = expectedCostNano({ input_tokens: 800, output_tokens: 400 }, {
 *       input_nano_usd_per_m: '3000', cached_read_nano_usd_per_m: '300',
 *       cache_write_nano_usd_per_m: '3000', output_nano_usd_per_m: '15000', per_request_nano_usd: '0',
 *   });   // 3n (input) + 6n (output) = 9n
 */

// ── Money: integer nano-USD (decision D1) ────────────────────────────────────

/** One nano-USD: 1e-9 USD. Every money amount in the AI Exchange is an integer count of these. */
const NANO_USD = 1000000000n;

/** Tokens per million: the denominator of every per-million-token rate. */
const TOKENS_PER_MILLION = 1000000n;

/**
 * A money amount as a BigInt count of nano-USD. A string is the wire form (ai.model@1 stores money as a
 * string); a number is accepted only when it is a whole number of nano-USD (never a float of dollars: a
 * fractional dollar is a bug, not a rounding opportunity). null/undefined/'' is zero.
 */
function nanoUsd(value) {
    if (value == null || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError(`nanoUsd: ${value} is not a whole number of nano-USD`);
        return BigInt(value);
    }
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) throw new TypeError(`nanoUsd: "${s}" is not an integer amount of nano-USD`);
    return BigInt(s);
}

/**
 * The charge of `tokens` at `rateNanoPerM` nano-USD per million tokens, rounded UP (never down): the customer is
 * never under-charged for a request, and the platform never eats a fraction of a nano-USD silently.
 * `ceil(tokens * rate / 1e6)`.
 */
function chargeTokens(tokens, rateNanoPerM) {
    const t = BigInt(Math.max(0, Math.floor(Number(tokens) || 0)));
    const rate = nanoUsd(rateNanoPerM);
    if (!t || !rate) return 0n;
    return (t * rate + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
}

/** The four token classes, in the order the settlement uses: input, cached read, cache write, output. */
const TOKEN_CLASSES = ['input_tokens', 'cached_read_tokens', 'cache_write_tokens', 'output_tokens'];

/** The rate field each token class is priced by. */
const RATE_FIELDS = {
    input_tokens: 'input_nano_usd_per_m',
    cached_read_tokens: 'cached_read_nano_usd_per_m',
    cache_write_tokens: 'cache_write_nano_usd_per_m',
    output_tokens: 'output_nano_usd_per_m',
};

/**
 * The rate of one token class, from either shape a rate travels in:
 *  - the flat ai.model@1 retail_rate: `input_nano_usd_per_m`, `cached_read_nano_usd_per_m`, …;
 *  - the nested settlement rate (billing.inference-settlement@1): `nano_usd_per_m: { input, cached_read, … }`.
 * A missing rate is zero, never a guess.
 */
function rateFor(rates, tokenClass) {
    const r = rates || {};
    const flat = r[RATE_FIELDS[tokenClass]];
    if (flat != null) return flat;
    const perM = r.nano_usd_per_m || r.rates || null;
    if (!perM) return 0n;
    const key = {
        input_tokens: 'input', cached_read_tokens: 'cached_read', cache_write_tokens: 'cache_write', output_tokens: 'output',
    }[tokenClass];
    return perM[key] != null ? perM[key] : 0n;
}

/**
 * The expected cost of one request, in nano-USD: each token class charged once at its own rate (ceil), plus the
 * per-request fee. `usage` counts tokens; `rates` is an ai.model@1 retail_rate (or a supply rate card) with the
 * four nano-USD-per-million rates and the per-request fee.
 *
 *   expectedCostNano({ input_tokens: 800, output_tokens: 400 }, {
 *       input_nano_usd_per_m: '3000', cached_read_nano_usd_per_m: '300',
 *       cache_write_nano_usd_per_m: '3000', output_nano_usd_per_m: '15000', per_request_nano_usd: '0',
 *   });   // 3n (input: 800 * 3000 / 1e6 = 2.4, up) + 6n (output: 400 * 15000 / 1e6 = 6) = 9n
 */
function expectedCostNano(usage, rates) {
    const u = usage || {};
    let total = 0n;
    for (const cls of TOKEN_CLASSES) {
        const tokens = u[cls] != null ? u[cls] : (cls === 'input_tokens' ? u.input : 0);
        total += chargeTokens(tokens, rateFor(rates, cls));
    }
    const perRequest = (rates && rates.per_request_nano_usd != null) ? rates.per_request_nano_usd : 0;
    return total + nanoUsd(perRequest);
}

/**
 * The cost of one SUCCESS, in nano-USD: `expected / max(p_success, floor)`.
 * `pSuccess` is the chance the request succeeds there (0..1); `floor` (default 0.1) keeps a tiny probability from
 * dividing the cost into infinity. A probability at or below zero has no cost per success: it is not a candidate
 * the planner may choose (the caller excludes it before scoring).
 *
 * The division is integer: the divisor is fixed-point at 1e-9 (nine decimals of a probability), and the result is
 * rounded UP to a whole nano-USD, so a candidate is never flattered by a fraction of a nano-USD.
 */
function costPerSuccessNano(expectedNano, pSuccess, floor = 0.1) {
    const cost = typeof expectedNano === 'bigint' ? expectedNano : nanoUsd(expectedNano);
    const p = Number(pSuccess);
    const f = Number(floor);
    const eff = Number.isFinite(p) && p > 0 ? p : 0;
    const fl = Number.isFinite(f) && f > 0 ? f : 0;
    if (!eff) return null;                       // no chance of success: no cost per success
    const divisor = Math.max(eff, fl);
    const scaled = BigInt(Math.round(divisor * 1000000000));   // the divisor at 1e-9
    if (!scaled) return null;
    return (cost * 1000000000n + scaled - 1n) / scaled;   // ceil
}

/** A money amount as the wire string: a decimal count of nano-USD, never a float. */
function formatNanoUsd(nano) {
    return (typeof nano === 'bigint' ? nano : nanoUsd(nano)).toString();
}

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

module.exports = {
    rateCard, costSnapshot, estimate, validateRateCard, validateCostSnapshot,
    nanoUsd, chargeTokens, expectedCostNano, costPerSuccessNano, formatNanoUsd, rateFor,
    NANO_USD, TOKENS_PER_MILLION, TOKEN_CLASSES, RATE_FIELDS,
};
