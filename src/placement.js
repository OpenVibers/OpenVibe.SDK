'use strict';
/**
 * openvibe-sdk/placement — where a workload runs (roadmap WS-Z9, decision 43; the event fabric WS-Z3 and the provider
 * router WS-Z10 use the same planner). Pure functions over data, no I/O: callers pass the offers they know
 * (platform.resource-offer@1), the provider rate cards and usage (platform.rate-card@1, platform.provider-state@1)
 * and the workload's requirements (platform.workload-requirements@1).
 *
 *   const { plan, marginalCost, rendezvous, pickTwo, signPlan, verifyPlan } = require('openvibe-sdk/placement');
 *   const r = plan(requirements, offers, { rateCards, states, now, current });   // platform.placement-result@1
 *
 * The rules:
 *  - hard constraints first: capabilities, trust, residency/region, health, latency ceiling, capacity, cost ceiling.
 *    A cheaper candidate that misses one is excluded, with the reason, never chosen;
 *  - then the objective: `lowest-latency` minimises measured latency within the budget; `cheapest` minimises
 *    marginal cost within the latency ceiling; `balanced` weighs both; `correctness` keeps the authority (the
 *    candidate named in `requirements.authority`, or the current placement) and never moves for cost;
 *  - marginal cost is priced in each provider's real billing unit after its free allowance, forecast to the end of
 *    the period and with a reserve kept for higher-priority work; owned (prepaid) capacity costs ~0 until its
 *    binding resource is busy, then rises so work spills to free or paid capacity before the node saturates;
 *  - hysteresis: a candidate replaces the current placement only when it is clearly better (`minGain`), or when
 *    the current one is no longer eligible (failover is immediate).
 */
const crypto = require('crypto');

const TRUST_ORDER = ['first-party', 'user-owned', 'partner', 'community', 'external'];
const HEALTH_OK = new Set(['up', 'degraded']);

// ── Cost ─────────────────────────────────────────────────────────────────────

/** Price of `units` in one rate card over a period, after its free allowance: whole billing units (unit_size). */
function priceOf(card, units) {
    const billable = Math.max(0, units - (Number(card.free_allowance) || 0));
    if (!billable) return 0;
    const size = Number(card.unit_size) || 1;
    return (billable / size) * (Number(card.unit_price_usd) || 0);   // unit_price_usd is per unit_size, prorated as providers bill
}

/**
 * Linear forecast of a period's usage: what was used so far, run to the end of the period at the same rate.
 * `start`/`end`/`now` in ms.
 */
function forecast(used, start, end, now) {
    const elapsed = Math.max(1, now - start);
    const total = Math.max(elapsed, end - start);
    return used * (total / elapsed);
}

/**
 * The marginal cost of `projected` more units on a provider this period: cost(forecast + projected) −
 * cost(forecast), where the free allowance shrinks by the reserve kept for higher-priority work (unless this work
 * is itself high priority). When the forecast says the allowance runs out anyway, the next unit is priced as paid:
 * a free allowance that will not last is not free.
 */
function marginalCost(card, state, projected, { now = Date.now(), priority = 'normal' } = {}) {
    const metric = card.metric;
    const used = Number((state && state.usage && state.usage[metric]) || 0);
    const start = state && state.period_start ? Date.parse(state.period_start) : now;
    const end = state && state.period_end ? Date.parse(state.period_end) : now;
    const expected = state && state.forecast && state.forecast[metric] != null ? Number(state.forecast[metric]) : forecast(used, start, end, now);
    const reserveShare = priority === 'high' ? 0 : Number((state && state.reserve && state.reserve[metric]) || 0);
    const effective = { ...card, free_allowance: (Number(card.free_allowance) || 0) * (1 - reserveShare) };
    return Math.max(0, priceOf(effective, expected + projected) - priceOf(effective, expected));
}

/**
 * Owned (prepaid) capacity: ~0 while the binding resource is below `busy` (default 0.6), rising steeply to `max`
 * above it, so background work spills elsewhere before the node saturates. Utilisation is the highest of CPU,
 * memory, disk and GPU the offer reports.
 */
function ownedLoadCost(offer, { busy = 0.6, full = 0.9, maxUsd = 0.001 } = {}) {
    const c = offer.capacity || {};
    const u = Math.max(0, ...['cpu', 'memory', 'disk', 'gpu'].map((k) => Number((c[k] && c[k].utilization) || 0)));
    if (u <= busy) return 0;
    if (u >= full) return maxUsd;
    return maxUsd * ((u - busy) / (full - busy)) ** 2;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

function latencyOf(offer, op) {
    const l = offer.latency_ms || {};
    if (op && l[op] != null) return Number(l[op]);
    const vals = Object.entries(l).filter(([k]) => /p95/.test(k)).map(([, v]) => Number(v));
    return vals.length ? Math.min(...vals) : null;
}

/** Why an offer cannot run the workload, or null when it can. */
function excluded(req, offer) {
    const caps = new Set(offer.capabilities || []);
    for (const c of req.capabilities || []) if (!caps.has(c)) return `lacks ${c}`;
    const trust = req.trust && req.trust.length ? req.trust : TRUST_ORDER;
    if (!trust.includes(offer.trust)) return `workload requires ${trust.join(' or ')} trust`;
    if (req.residency && offer.region !== req.residency && !(offer.regions || []).includes(req.residency)) return `outside ${req.residency}`;
    if (req.region && req.region !== 'nearest' && offer.region !== req.region && offer.region !== 'global') return `not in ${req.region}`;
    const h = offer.health || {};
    if (!HEALTH_OK.has(h.status)) return `health ${h.status || 'unknown'}`;
    const lat = latencyOf(offer, req.latency_op);
    if (req.max_latency_ms != null && lat != null && lat > req.max_latency_ms) return `p95 ${lat} ms over ${req.max_latency_ms} ms`;
    const r = req.resources || {};
    const c = offer.capacity || {};
    if (r.cpu && c.cpu && c.cpu.available_cores != null && c.cpu.available_cores < r.cpu) return `${c.cpu.available_cores} cores free, needs ${r.cpu}`;
    if (r.memory_mb && c.memory && c.memory.available_mb != null && c.memory.available_mb < r.memory_mb) return `${c.memory.available_mb} MB free, needs ${r.memory_mb}`;
    if (r.gpu && !(c.gpu && c.gpu.type)) return 'no GPU';
    for (const cap of req.capabilities || []) {
        const kind = /^worker:(.+)$/.exec(cap);
        if (kind && c.workers && c.workers[kind[1]] === 0) return `no free ${kind[1]} worker`;
    }
    return null;
}

// ── The planner ──────────────────────────────────────────────────────────────

function estimateCost(req, offer, ctx) {
    const units = Number(req.units || 1);
    if (offer.pricing && offer.pricing.model === 'prepaid') return ownedLoadCost(offer, ctx.owned) * units;
    const card = offer.pricing && offer.pricing.rate_card && ctx.rateCards.get(offer.pricing.rate_card);
    if (card) return marginalCost(card, ctx.states.get(card.provider) || ctx.states.get(offer.provider), units, { now: ctx.now, priority: req.latency_class === 'critical' || req.latency_class === 'realtime' ? 'high' : 'normal' });
    const per = offer.pricing && offer.pricing.marginal_usd_per_unit;
    return per != null ? Number(per) * units : Infinity;   // an unpriced paid provider is never assumed free
}

/**
 * plan(requirements, offers, { rateCards, states, now, current, minGain, weights }) → platform.placement-result@1.
 * rateCards: array or Map by id; states: array or Map by provider (platform.provider-state@1); current: the id
 * the workload runs on now (hysteresis); minGain: relative improvement needed to move (default 0.15).
 */
function plan(req, offers, { rateCards = [], states = [], now = Date.now(), current = null, minGain = 0.15, weights = { cost: 0.5, latency: 0.5 }, owned = {} } = {}) {
    const ctx = {
        now, owned,
        rateCards: rateCards instanceof Map ? rateCards : new Map(rateCards.map((c) => [c.id, c])),
        states: states instanceof Map ? states : new Map(states.map((s) => [s.provider, s])),
    };
    const objective = req.objective || 'balanced';
    // Objectives that are really constraints: private and first-party work never leaves first-party capacity.
    if ((objective === 'first-party-only' || objective === 'private') && !(req.trust && req.trust.length)) req = { ...req, trust: ['first-party'] };
    const candidates = offers.map((o) => {
        const why = excluded(req, o);
        if (why) return { id: o.offer_id, eligible: false, excluded_because: why };
        const cost = estimateCost(req, o, ctx);
        if (req.max_cost_usd != null && cost > req.max_cost_usd) return { id: o.offer_id, eligible: false, excluded_because: `estimated $${cost.toFixed(6)} over $${req.max_cost_usd}` };
        const lat = latencyOf(o, req.latency_op);
        return { id: o.offer_id, eligible: true, estimated_cost_usd: cost, estimated_latency_ms: lat == null ? undefined : lat, trust: o.trust };
    });
    const ok = candidates.filter((c) => c.eligible && Number.isFinite(c.estimated_cost_usd));
    const reasons = [];
    if (!ok.length) return { selected: null, objective, reasons: ['no eligible candidate'], candidates: strip(candidates), decided_at: new Date(now).toISOString() };

    const maxCost = Math.max(...ok.map((c) => c.estimated_cost_usd), 1e-12);
    const lats = ok.map((c) => c.estimated_latency_ms).filter((x) => x != null);
    const maxLat = Math.max(...lats, 1);
    for (const c of ok) {
        const nc = c.estimated_cost_usd / maxCost;
        const nl = (c.estimated_latency_ms == null ? maxLat : c.estimated_latency_ms) / maxLat;
        c.score = objective === 'cheapest' ? nc + nl * 1e-3
            : objective === 'lowest-latency' ? nl + nc * 1e-3
                : nc * weights.cost + nl * weights.latency;
        c.score = Number(c.score.toFixed(6));
    }
    ok.sort((a, b) => a.score - b.score || (a.estimated_latency_ms ?? Infinity) - (b.estimated_latency_ms ?? Infinity));
    let best = ok[0];
    const cur = current && ok.find((c) => c.id === current);
    if (objective === 'correctness' || req.latency_class === 'critical') {
        const authority = (req.authority && ok.find((c) => c.id === req.authority)) || cur;
        if (authority) { best = authority; reasons.push('the authority keeps critical work'); }
    } else if (cur && cur !== best) {
        const gain = cur.score > 0 ? (cur.score - best.score) / cur.score : 0;
        if (gain < minGain) { best = cur; reasons.push(`stays on ${cur.id}: the best alternative is only ${(gain * 100).toFixed(1)}% better (needs ${(minGain * 100).toFixed(0)}%)`); }
    } else if (current && !cur) reasons.push(`${current} is no longer eligible: moved`);
    if (best.estimated_cost_usd === 0) reasons.push('no marginal cost (already-paid capacity or a free allowance)');
    if (req.max_latency_ms != null) reasons.push(`meets the ${req.max_latency_ms} ms latency ceiling`);
    reasons.push(`objective ${objective}`);
    return { selected: best.id, objective, reasons, candidates: strip(candidates), decided_at: new Date(now).toISOString() };
}

function strip(cands) {
    return cands.map(({ trust, ...c }) => c);   // platform.placement-result@1 candidate shape
}

// ── Stable assignment and local balancing ────────────────────────────────────

/** Weighted rendezvous (highest random weight) hashing: the target for `key`; adding or removing one moves little. */
function rendezvous(key, targets) {
    let best = null; let bestScore = -Infinity;
    for (const t of targets) {
        const w = Number(t.weight == null ? 1 : t.weight);
        if (!(w > 0)) continue;
        const h = crypto.createHash('sha256').update(`${t.id}\u0000${key}`).digest();
        const u = (h.readUInt32BE(0) + 1) / 4294967297;   // (0, 1)
        const score = -w / Math.log(u);
        if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
}

/** Power of two choices: two random candidates, the one with less load (least-request without a thundering herd). */
function pickTwo(items, load, rand = Math.random) {
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    const i = Math.floor(rand() * items.length);
    let j = Math.floor(rand() * (items.length - 1));
    if (j >= i) j++;
    return load(items[j]) < load(items[i]) ? items[j] : items[i];
}

// ── Signed route plans (platform.placement-plan@1) ───────────────────────────

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

/** Sign a plan with an Ed25519 private key (PEM or KeyObject): returns the plan with `signature`. */
function signPlan(planBody, privateKey) {
    const { signature, ...body } = planBody;
    const sig = crypto.sign(null, Buffer.from(canonical(body)), privateKey);
    return { ...body, signature: sig.toString('base64url') };
}

/**
 * Verify a plan: its key id is known, the signature matches, and it has not expired. Returns { ok, reason }.
 * publicKeys: { [key_id]: PEM | KeyObject }. A caller keeps using its last valid plan when a new one fails this.
 */
function verifyPlan(p, publicKeys, { now = Date.now() } = {}) {
    if (!p || !p.signature) return { ok: false, reason: 'unsigned' };
    const key = publicKeys && publicKeys[p.key_id];
    if (!key) return { ok: false, reason: `unknown key ${p.key_id}` };
    const { signature, ...body } = p;
    let good = false;
    try { good = crypto.verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature, 'base64url')); } catch { good = false; }
    if (!good) return { ok: false, reason: 'bad signature' };
    if (Date.parse(p.expires_at) <= now) return { ok: false, reason: 'expired' };
    return { ok: true };
}

/**
 * A holder for the current route plan: accept() takes a newer valid plan and keeps the old one otherwise, so a
 * control-plane outage or a bad plan never stops delivery (decision 42).
 */
function createPlanHolder(publicKeys, { now = () => Date.now(), onReject = null } = {}) {
    let current = null;
    return {
        get: () => current,
        accept(p) {
            const v = verifyPlan(p, publicKeys, { now: now() });
            if (!v.ok || (current && p.epoch <= current.epoch)) {
                if (onReject) onReject(v.ok ? `epoch ${p.epoch} is not newer than ${current.epoch}` : v.reason);
                return false;
            }
            current = p;
            return true;
        },
        targets(route) { const r = current && current.routes.find((x) => x.route === route); return r ? r.targets : null; },
    };
}

/** The five trust classes (T1 ADR-046): the order is the planner's preference when no list is named. */
const TRUST_CLASSES = ['first-party', 'user-owned', 'partner', 'community', 'external'];

module.exports = { plan, excluded, marginalCost, priceOf, forecast, ownedLoadCost, rendezvous, pickTwo, signPlan, verifyPlan, createPlanHolder, canonical, TRUST_CLASSES, TRUST_ORDER };
