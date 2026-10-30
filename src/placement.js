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
 *   const { place } = require('openvibe-sdk/placement');
 *   const p = place(requirements, offers, { now, person, step: { kind: 'code.fix' }, rules, priors, outcomes });
 *   // → { result, line, ranked, rejected, fallback }: the plan, why, and the one sentence a person reads.
 *
 * The rules:
 *  - hard constraints first: capabilities, trust, residency/region, health, latency ceiling, capacity, cost ceiling.
 *    A cheaper candidate that misses one is excluded, with the reason, never chosen. When `requirements.trust` is
 *    absent the default is DEFAULT_TRUST, the contract's four classes: user-owned is never a default;
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
// platform.workload-requirements@1: "when absent, first-party, partner, community and external. user-owned is
// never a default: a user-owned offer is eligible only when this list names it".
const DEFAULT_TRUST = ['first-party', 'partner', 'community', 'external'];
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
    const trust = req.trust && req.trust.length ? req.trust : DEFAULT_TRUST;
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
 * plan(requirements, offers, { rateCards, states, now, current, minGain, weights, success }) → platform.placement-result@1.
 * rateCards: array or Map by id; states: array or Map by provider (platform.provider-state@1); current: the id
 * the workload runs on now (hysteresis); minGain: relative improvement needed to move (default 0.15).
 * success: optional { [offer_id]: p }, the chance the step succeeds there (0..1). When present, the cost part of
 * the score is the cost per success (estimated_cost_usd / p); estimated_cost_usd in the result stays the raw cost.
 */
function plan(req, offers, { rateCards = [], states = [], now = Date.now(), current = null, minGain = 0.15, weights = { cost: 0.5, latency: 0.5 }, owned = {}, success = null } = {}) {
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
    const probabilities = new Map(success instanceof Map ? success : Object.entries(success || {}));
    // The cost part of the score is the cost per success when a chance was given; the result keeps the raw cost.
    const costForScore = (c) => {
        const p = probabilities.get(c.id);
        return p != null && p > 0 ? c.estimated_cost_usd / p : c.estimated_cost_usd;
    };
    const ok = candidates.filter((c) => {
        if (!c.eligible || !Number.isFinite(c.estimated_cost_usd)) return false;
        const p = probabilities.get(c.id);
        if (p != null && !(p > 0)) { c.eligible = false; c.excluded_because = 'no chance of success'; return false; }
        return true;
    });
    const reasons = [];
    if (!ok.length) return { selected: null, objective, reasons: ['no eligible candidate'], candidates: strip(candidates), decided_at: new Date(now).toISOString() };

    const maxCost = Math.max(...ok.map(costForScore), 1e-12);
    const lats = ok.map((c) => c.estimated_latency_ms).filter((x) => x != null);
    const maxLat = Math.max(...lats, 1);
    for (const c of ok) {
        const nc = costForScore(c) / maxCost;
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

// ── Placement v1: quality, rules, learning and a reason ─────────────────────
//
// place() is plan() with the plan's road: the person's rules and ownership, a quality bar, a success estimate and
// one sentence saying why. Every function here is pure: now comes in, no clock, no randomness, no I/O.

const DAY_MS = 86400000;
const HALF_LIFE_DAYS = 14;

/** The option key: offer_id plus the offer's model (or harness) when it carries one, e.g. app:codes/claude-code@opus. */
function optionKey(offer) {
    if (!offer) return '';
    const model = offer.model || (offer.detail && offer.detail.model);
    const harness = offer.harness || (offer.detail && offer.detail.harness);
    const tag = model || harness;
    return tag ? `${offer.offer_id}@${tag}` : String(offer.offer_id == null ? '' : offer.offer_id);
}

const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Date.parse(v));

/** Exponential decay with a 14-day half-life, from `from` to `to`; a future stamp does not grow a count. */
function decayCount(count, from, to) {
    const a = timeOf(from);
    const b = timeOf(to);
    const n = Number(count) || 0;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return n;
    return n * (0.5 ** ((b - a) / (HALF_LIFE_DAYS * DAY_MS)));
}

const rowPerson = (r) => r.person;
const rowKey = (r) => r.key;

/**
 * learn(outcomes, { person, key, kind, ok, at }) → new outcomes (never mutates).
 * Counts are decayed to `at` from their updated_at, then this try is added: ok_w += ok ? 1 : 0, n_w += 1.
 */
function learn(outcomes, { person, key, kind, ok, at } = {}) {
    const atMs = timeOf(at);
    if (!Number.isFinite(atMs)) throw new Error('learn needs at (ms or ISO date-time)');
    const source = Array.isArray(outcomes) ? outcomes : [];
    const next = source.map((r) => ({ ...r }));
    const row = next.find((r) => rowPerson(r) === person && rowKey(r) === key && r.kind === kind);
    const stamp = new Date(atMs).toISOString();
    if (row) {
        row.ok_w = decayCount(row.ok_w, row.updated_at, atMs) + (ok ? 1 : 0);
        row.n_w = decayCount(row.n_w, row.updated_at, atMs) + 1;
        row.updated_at = stamp;
    } else {
        next.push({ person, key, kind, ok_w: ok ? 1 : 0, n_w: 1, updated_at: stamp });
    }
    return next;
}

/** The kind chain: exact, then each dotted parent, then every kind (null). */
function kindChain(kind) {
    const chain = [];
    if (kind) {
        const parts = String(kind).split('.').filter(Boolean);
        for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join('.'));
    }
    chain.push(null);
    return chain;
}

/**
 * successOf(outcomes, { person, key, kind, prior, now }) → p in [0, 1].
 * Beta mean: (k·prior + okP + w·okG) / (k + nP + w·nG), with w = min(1, 20 / nG). Counts decay at read time.
 * The kind falls back by dotted prefix, then to the key's counts over every kind.
 */
function successOf(outcomes, { person, key, kind, prior, now } = {}) {
    const source = Array.isArray(outcomes) ? outcomes : [];
    let rows = [];
    for (const level of kindChain(kind)) {
        const atLevel = source.filter((r) => rowKey(r) === key && (level == null || r.kind === level));
        const total = atLevel.reduce((sum, r) => sum + decayCount(r.n_w, r.updated_at, now), 0);
        if (total > 0) { rows = atLevel; break; }
    }
    if (!rows.length) rows = source.filter((r) => rowKey(r) === key);   // all-zero counts still keep the person/global split

    let okP = 0; let nP = 0; let okG = 0; let nG = 0;
    for (const r of rows) {
        const ok = decayCount(r.ok_w, r.updated_at, now);
        const n = decayCount(r.n_w, r.updated_at, now);
        okG += ok; nG += n;
        if (rowPerson(r) === person) { okP += ok; nP += n; }
    }
    const hasPrior = prior != null && Number.isFinite(Number(prior));
    const k = hasPrior ? 4 : 2;
    const base = hasPrior ? Number(prior) : 0.7;
    const w = nG > 0 ? Math.min(1, 20 / nG) : 0;
    const p = (k * base + okP + w * okG) / (k + nP + w * nG);
    return Math.max(0, Math.min(1, Number.isFinite(p) ? p : base));
}

/** A user-owned machine's owner, or the offer itself; never someone else's. */
function ownedBy(offer, person) {
    return offer.trust === 'user-owned' && Boolean(person) && offer.owner === person;
}

/** Whether the machine says it is streaming (the contract has no field yet; Node starts sending health.streaming). */
function isStreaming(offer) {
    return Boolean(offer && ((offer.health && offer.health.streaming === true) || offer.streaming === true));
}

/** "a GPU" or "N cores" when the step needs one of them, else null. */
function neededResource(req) {
    const r = req.resources || {};
    if (r.gpu) return 'a GPU';
    if (Number(r.cpu) >= 2) return `${Number(r.cpu)} cores`;
    return null;
}

/** The rules as requirements; each is a hard filter, never weighed. */
function applyRules(req, rules = {}) {
    const out = { ...req };
    if (rules.noCloud) out.trust = ['user-owned'];
    if (rules.onlyFree) out.max_cost_usd = 0;
    if (rules.region) out.residency = rules.region;
    if (rules.maxCostUsd != null) out.max_cost_usd = Math.min(out.max_cost_usd == null ? Infinity : out.max_cost_usd, Number(rules.maxCostUsd));
    if (rules.prefer && !out.objective) out.objective = rules.prefer === 'fastest' ? 'lowest-latency' : rules.prefer;
    return out;
}

/** Why a rule or this call's exclusion list keeps an offer out, in plain words, or null. */
function ruleExcluded(offer, rules, person, exclude) {
    if (exclude && exclude[offer.offer_id]) return exclude[offer.offer_id];
    if (offer.trust === 'user-owned') {
        if (!person) return 'a user-owned machine needs its owner';
        if (!offer.owner) return 'a user-owned machine has no owner';
        if (offer.owner !== person) return "another person's machine";
    }
    if (rules.noCloud && !ownedBy(offer, person)) return 'your rule: never send my repo to the cloud';
    if (rules.uncensored !== true && (offer.capabilities || []).includes('model:uncensored')) return 'uncensored models are off in your rules';
    return null;
}

const KEY_LIKE = /\b[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}\b/gi;
const PATH_LIKE = /(?:^|\s)\/(?:[^/\s]+\/)+[^\s]*/g;

/** A name safe to put in a sentence: no key-like id and no path. */
function safeName(value) {
    let s = String(value == null ? '' : value);
    s = s.replace(KEY_LIKE, 'a machine').replace(PATH_LIKE, ' a machine');
    return s.replace(/\s+/g, ' ').trim() || 'an option';
}

/** The offer's name: `names[offer_id]`, else provider and model, else the id. */
function displayName(offer, names = {}) {
    if (!offer) return 'an option';
    if (names && names[offer.offer_id]) return safeName(names[offer.offer_id]);
    const provider = offer.provider && offer.provider !== 'self' ? offer.provider : null;
    const model = offer.model || (offer.detail && offer.detail.model);
    if (provider && model) return safeName(`${provider} ${model}`);
    if (model) return safeName(model);
    if (provider) return safeName(provider);
    return safeName(offer.offer_id);
}

/** Dollars to 3 significant figures. */
function money(usd) {
    const n = Number(usd);
    if (!Number.isFinite(n)) return 'unpriced';
    if (n === 0) return '$0';
    return `$${String(Number(n.toPrecision(3)))}`;
}

const pct = (p) => Math.round((Number(p) || 0) * 100);

const timesWord = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function failureText(reason, count = 1) {
    if (reason === 'quality') return `failed this ${timesWord(count)}`;
    if (reason === 'busy') return 'was busy';
    if (reason === 'offline') return 'was offline';
    if (reason === 'refused' || reason === 'budget') return 'said no';
    if (reason === 'timeout') return 'timed out';
    return 'failed';
}

/**
 * lineFor(facts) → the one sentence. Fixed templates, no model; facts are the two things that decided the pick.
 * The line never names another person, a key or a path.
 */
function lineFor(f = {}) {
    const name = safeName(f.name);
    if (!f.selected) {
        if (f.fallback) return `Nothing meets the bar for ${f.step || 'this'}; the best is ${safeName(f.fallback.name)} at ${pct(f.fallback.success)}%. Ask before going ahead?`;
        return 'Ask the person: nothing can run this.';
    }
    if (f.failure) return `Moved to ${name}: ${safeName(f.previousName)} ${failureText(f.failure.reason, f.failure.count || 1)}.`;
    if (f.staying && f.gain != null) return `Staying on ${name}: the best alternative is only ${pct(f.gain)}% better.`;
    if (f.streaming) return `On ${name}: ${safeName(f.streaming)} is streaming, and this needs ${f.gpu ? 'a GPU' : `${Number(f.cores)} cores`}.`;
    if (f.owned && f.free) return `On ${name}: it has your ${f.provider ? `${safeName(f.provider)} ` : ''}sign-in and your files, and it's free.`;
    if (f.cheapest) return `On ${name}: the cheapest that meets the bar (${money(f.costUsd)} a try, ${pct(f.success)}% expected).`;
    return `On ${name}: it meets the bar (${money(f.costUsd)} a try, ${pct(f.success)}% expected).`;
}

/**
 * place(requirements, offers, ctx) → { result, line, ranked, rejected, fallback, floor, escalations, excluded }.
 * ctx is plan()'s context plus person, step: {kind}, floor, priors, outcomes, rules and names. The result is exactly
 * what plan() returns for the offers the rules and the bar left in (validate it as today).
 */
function place(requirements, offers, ctx = {}) {
    const person = ctx.person;
    const rules = ctx.rules || {};
    const step = ctx.step || {};
    const kind = step.kind || requirements.kind || 'this';
    const floor = ctx.floor == null ? 0.5 : Number(ctx.floor);
    const req = applyRules(requirements, rules);
    const rejected = [];
    const seen = new Set();
    const reject = (id, why) => { if (!seen.has(id)) { seen.add(id); rejected.push({ id, why }); } };

    const survivors = [];
    for (const offer of offers) {
        const why = ruleExcluded(offer, rules, person, ctx.exclude)
            || (neededResource(req) && isStreaming(offer) ? 'it is streaming' : null);
        if (why) { reject(offer.offer_id, why); continue; }
        const key = optionKey(offer);
        const prior = ctx.priors ? ctx.priors[key] : undefined;
        survivors.push({ offer, key, success: successOf(ctx.outcomes, { person, key, kind, prior, now: ctx.now }) });
    }

    const above = [];
    let fallback = null;
    for (const c of survivors) {
        if (c.success < floor) {
            reject(c.offer.offer_id, `below the bar for ${kind} (${pct(c.success)}% < ${pct(floor)}%)`);
            if (!fallback || c.success > fallback.success || (c.success === fallback.success && c.offer.offer_id < fallback.id)) {
                fallback = { id: c.offer.offer_id, success: c.success };
            }
        } else above.push(c);
    }

    const success = {};
    for (const c of above) success[c.offer.offer_id] = c.success;
    const result = plan(req, above.map((c) => c.offer), { ...ctx, success });
    const byId = new Map(result.candidates.map((c) => [c.id, c]));
    const ranked = [];
    for (const c of above) {
        const cand = byId.get(c.offer.offer_id);
        if (!cand || !cand.eligible || !Number.isFinite(cand.estimated_cost_usd)) {
            if (cand && !cand.eligible) reject(c.offer.offer_id, cand.excluded_because);
            continue;
        }
        ranked.push({
            id: c.offer.offer_id, success: c.success, cost_usd: cand.estimated_cost_usd,
            cost_per_success_usd: c.success > 0 ? cand.estimated_cost_usd / c.success : Infinity,
            score: cand.score,
        });
    }
    ranked.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || (byId.get(a.id).estimated_latency_ms ?? Infinity) - (byId.get(b.id).estimated_latency_ms ?? Infinity) || (a.id < b.id ? -1 : 1));
    for (const r of ranked) delete r.score;

    const picked = result.selected ? above.find((c) => c.offer.offer_id === result.selected) : null;
    let line;
    if (!picked) {
        const fb = fallback && offers.find((o) => o.offer_id === fallback.id);
        line = lineFor({
            selected: false, step: kind,
            fallback: above.length === 0 && fallback ? { name: displayName(fb, ctx.names), success: fallback.success } : null,
        });
    } else {
        const cand = byId.get(picked.offer.offer_id);
        const cps = ranked.find((r) => r.id === picked.offer.offer_id);
        const min = ranked.length ? Math.min(...ranked.map((r) => r.cost_per_success_usd)) : Infinity;
        const stuck = ctx.current === picked.offer.offer_id
            ? (result.reasons || []).find((r) => /only ([\d.]+)% better/.test(r))
            : null;
        const gain = stuck ? Number(/only ([\d.]+)%/.exec(stuck)[1]) / 100 : null;
        let streamingRejected = null;
        if (neededResource(req)) {
            streamingRejected = (ctx.current && rejected.find((r) => r.id === ctx.current && r.why === 'it is streaming'))
                || rejected.find((r) => r.why === 'it is streaming');
        }
        const streamingOffer = streamingRejected && offers.find((o) => o.offer_id === streamingRejected.id);
        line = lineFor({
            selected: true,
            name: displayName(picked.offer, ctx.names),
            owned: ownedBy(picked.offer, person),
            free: cand.estimated_cost_usd === 0,
            provider: picked.offer.provider || (picked.offer.detail && picked.offer.detail.provider),
            streaming: streamingOffer ? displayName(streamingOffer, ctx.names) : null,
            cores: req.resources && req.resources.cpu,
            gpu: Boolean(req.resources && req.resources.gpu),
            staying: Boolean(stuck),
            gain,
            cheapest: cps ? cps.cost_per_success_usd <= min + 1e-12 : false,
            costUsd: cand.estimated_cost_usd,
            success: picked.success,
            step: kind,
        });
    }

    return {
        result, line, ranked,
        rejected,
        fallback: above.length === 0 ? fallback : null,
        floor,
        escalations: Number(ctx.escalations) || 0,
        excluded: rejected.map((r) => r.id),
    };
}

/**
 * escalate(previous, failure, requirements, offers, ctx) → the next place() answer, or, after two escalations,
 * { result: { selected: null }, line: 'Ask the person: …' }. The failed try is recorded in ctx.outcomes.
 */
function escalate(previous, failure, requirements, offers, ctx = {}) {
    const prev = previous || {};
    const attempts = Number(prev.escalations != null ? prev.escalations : ctx.escalations) || 0;
    const step = ctx.step || { kind: requirements.kind };
    const kind = step.kind || requirements.kind || 'this';
    const failedKey = (failure && (failure.option_id || failure.id)) || (prev.result && prev.result.selected) || null;
    const failed = offers.find((o) => o.offer_id === failedKey || optionKey(o) === failedKey) || null;
    const failedId = failed ? failed.offer_id : failedKey;
    let outcomes = ctx.outcomes;
    if (failedId && ctx.person && ctx.now != null) {
        outcomes = learn(outcomes, { person: ctx.person, key: optionKey(failed || { offer_id: failedId }), kind, ok: false, at: ctx.now });
    }
    if (attempts >= 2) {
        return {
            result: { selected: null },
            line: `Ask the person: three tries failed for ${kind}; should I go ahead?`,
            escalations: attempts + 1, outcomes: outcomes || [], excluded: prev.excluded || [],
        };
    }

    const exclude = { ...(ctx.exclude || {}) };
    for (const r of prev.rejected || []) if (!exclude[r.id]) exclude[r.id] = r.why;
    const reason = failure && failure.reason;
    const why = reason === 'quality' ? 'failed quality on the previous try'
        : reason === 'busy' ? 'was busy'
            : reason === 'offline' ? 'was offline'
                : reason === 'refused' || reason === 'budget' ? 'the provider said no'
                    : reason === 'timeout' ? 'timed out'
                        : 'excluded after a failure';
    if (failedId) exclude[failedId] = why;
    if (reason === 'refused' || reason === 'budget') {
        const provider = (failure && failure.provider) || (failed && failed.provider);
        if (provider) for (const o of offers) if (o.provider === provider) exclude[o.offer_id] = 'the provider said no';
    }
    const floor = reason === 'quality'
        ? (Number(prev.floor == null ? (ctx.floor == null ? 0.5 : ctx.floor) : prev.floor) + 0.1)
        : (prev.floor == null ? ctx.floor : prev.floor);
    const nextReq = reason === 'timeout' ? { ...requirements, objective: 'lowest-latency' } : requirements;
    const next = place(nextReq, offers, { ...ctx, outcomes, exclude, floor, escalations: attempts + 1 });
    let line = next.line;
    if (next.result.selected) {
        const selected = offers.find((o) => o.offer_id === next.result.selected);
        const previousOffer = failed || offers.find((o) => o.offer_id === (prev.result && prev.result.selected));
        line = lineFor({
            selected: true,
            name: displayName(selected, ctx.names),
            failure: { reason, count: attempts + 1 },
            previousName: displayName(previousOffer, ctx.names),
        });
    }
    return { ...next, line, escalations: attempts + 1, outcomes: outcomes || [] };
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

/** The five trust classes (T1 ADR-046). TRUST_ORDER is the preference order; DEFAULT_TRUST is the contract default. */
const TRUST_CLASSES = ['first-party', 'user-owned', 'partner', 'community', 'external'];

module.exports = {
    plan, excluded, marginalCost, priceOf, forecast, ownedLoadCost, rendezvous, pickTwo,
    signPlan, verifyPlan, createPlanHolder, canonical,
    place, escalate, optionKey, learn, successOf, lineFor,
    TRUST_CLASSES, TRUST_ORDER, DEFAULT_TRUST,
};
