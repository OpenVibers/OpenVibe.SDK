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
 *
 *   const { planAi } = require('openvibe-sdk/placement');
 *   const r = planAi(requirements, deployments, { enabled: true, usage, evidence, rates });
 *   // → { chosen, rejected: [{ id, reason }], objective, estimate, explain }
 *
 * planAi() is the AI Exchange face of this ONE planner (plan-state 2026-10-22 §E, G-P1/P7; decisions D1 and D5):
 * the same hard-constraints-first rule, priced in integer nano-USD and ranked by the expected cost per SUCCESS.
 * It is OFF by default: without `enabled: true` it answers nothing and changes no behaviour.
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
 * Beta mean: (k·prior + okP + w·okG) / (k + nP + w·nG), with w = min(1, 20 / nG). okG/nG are everyone else's
 * counts (the person's own rows are not counted twice). Counts decay at read time.
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
        if (rowPerson(r) === person) { okP += ok; nP += n; }
        else { okG += ok; nG += n; }
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

// platform.resource-offer@1 / Codes' harness capabilities: host-access is the person's machine and its files;
// tools are the harness's own tools (the CLI that holds the person's provider sign-in).
const CAP_HOST_ACCESS = 'harness:host-access';
const CAP_TOOLS = 'harness:tools';

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
        if (f.fallback) return `Nothing meets the bar for ${safeName(f.step || 'this')}; the best is ${safeName(f.fallback.name)} at ${pct(f.fallback.success)}%. Ask before going ahead?`;
        return 'Ask the person: nothing can run this.';
    }
    if (f.failure) return `Moved to ${name}: ${safeName(f.previousName)} ${failureText(f.failure.reason, f.failure.count || 1)}.`;
    if (f.staying && f.gain != null) return `Staying on ${name}: the best alternative is only ${pct(f.gain)}% better.`;
    if (f.streaming) return `On ${name}: ${safeName(f.streaming)} is streaming, and this needs ${f.gpu ? 'a GPU' : `${Number(f.cores)} cores`}.`;
    if (f.owned && f.free) {
        const provider = f.provider ? `${safeName(f.provider)} ` : '';
        if (f.signIn && f.files) return `On ${name}: it has your ${provider}sign-in and your files, and it's free.`;
        if (f.signIn) return `On ${name}: it has your ${provider}sign-in, and it's free.`;
        if (f.files) return `On ${name}: it has your files, and it's free.`;
        return `On ${name}: your own machine, and it's free.`;
    }
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
    const asked = new Set(requirements.capabilities || []);
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
            signIn: asked.has(CAP_TOOLS),
            files: asked.has(CAP_HOST_ACCESS),
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
 * { result: { selected: null }, line: 'Ask the person: …' }. The failed try is learned here exactly once and
 * returned as `outcomes`: the caller persists that set and must not record the same failure again.
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

// ── The AI Exchange planner (plan-state 2026-10-22 §E, G-P1/P7; decision D1 and D5) ────────────────────────────
//
// planAi() is the ONE planner's AI Exchange face: the same hard-constraints-first rule, but priced in integer
// nano-USD and ranked by the cost of one SUCCESS rather than by the cost of one attempt. It is a new entry point,
// not a second router: plan() still answers platform.placement-result@1 and is untouched.
//
// It is OFF by default. A caller must pass `enabled: true` (or set the feature flag) to get an answer; without
// it the planner refuses with the reason, so nothing changes behaviour until the owner turns it on.
//
// The rules:
//  - hard gates first, each one a reason, never a weight: the exact artifact, the commercial right
//    (provider_access), the privacy/trust class, the capabilities (tools, json, vision, stream, context), the
//    context bound, the health, and the cost ceiling;
//  - then the objective: the expected cost per SUCCESS, `expected_cost / max(p_success, floor)`, where p_success
//    comes from optional quality evidence and its confidence. Sparse evidence is MARKED (sparse_evidence), not
//    trusted: a candidate whose evidence is thin keeps a neutral probability and may not win on quality alone;
//  - money is integer nano-USD (D1): the four token classes and the per-request fee, charged once each, ceil.
//
// The answer explains itself: `explain.rejected` lists every candidate that was left out and why, and
// `explain.objective` says what the planner optimised for. No secret, no key, no host, no endpoint ever appears
// in a reason.

const { nanoUsd, expectedCostNano, costPerSuccessNano, formatNanoUsd } = require('./cost');

/** The commercial rights a paid managed route may use (decision D3). */
const PAID_PROVIDER_ACCESS = new Set(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE']);

/** The provider_access values of the AI Exchange (ai.inference-deployment@1). */
const PROVIDER_ACCESS = ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'];

/** The privacy classes a deployment may carry, from the strictest to the loosest. */
const PRIVACY_CLASSES = ['zero_retention', 'no_training', 'standard', 'unknown'];

/** The default probability floor: a candidate never divides its cost by less than this. */
const DEFAULT_P_FLOOR = 0.1;

/** The evidence below this many observations is sparse: it is marked, never trusted. */
const SPARSE_SAMPLE_COUNT = 20;

/** The capabilities a model may declare (ai.model@1): tools, json, vision, stream. */
const MODEL_CAPABILITIES = ['tools', 'json', 'vision', 'stream'];

/**
 * A reason a candidate was left out, with everything secret stripped: no key, no host, no endpoint, no path.
 * The candidate's own id is never in its own reason (the answer already says which candidate it was).
 */
function safeReason(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/\b[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}\b/gi, 'a key');                 // usr_…, prj_…, sec_…
    s = s.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, 'a key');                    // provider keys
    s = s.replace(/\bhttps?:\/\/[^\s,;)]+/gi, 'an endpoint');                          // urls
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'a host');                           // ipv4
    s = s.replace(/\b[a-zA-Z0-9-]+\.(?:internal|local|lan)\b/g, 'a host');           // internal host names
    s = s.replace(/(?:^|\s)\/(?:[^/\s]+\/)+[^\s]*/g, ' a path');                      // paths
    s = s.replace(/\s+/g, ' ').trim();
    return s || 'not eligible';
}

/** The candidate's id: the deployment id, else the model id, else the offer id. */
function candidateId(c) {
    return String((c && (c.id || c.deployment_id || c.offer_id || c.model_id)) || '');
}

/** The model the candidate runs: ai.model@1 id, else the artifact it loads, else the candidate's own id. */
function candidateModel(c) {
    return String((c && (c.model_id || c.model || c.artifact_id)) || candidateId(c));
}

/** The commercial right of the candidate, as ai.inference-deployment@1 names it. */
function candidateAccess(c) {
    return String((c && (c.provider_access || c.commercial_rights)) || '').toUpperCase();
}

/** The privacy class of the candidate: an explicit privacy_policy, else its trust tier. */
function candidatePrivacy(c) {
    const p = c && c.privacy_policy;
    if (p) return String(p);
    const tier = c && c.trust_tier;
    if (tier === 'first_party' || tier === 'owner_node') return 'zero_retention';
    if (tier === 'approved_wholesale') return 'standard';
    return 'unknown';
}

/** The capabilities the candidate declares: ai.model@1's four, read from the model or the candidate itself. */
function candidateCapabilities(c) {
    const src = (c && (c.capabilities || (c.model && c.model.capabilities) || (c.model_info && c.model_info.capabilities))) || {};
    const out = new Set();
    for (const k of MODEL_CAPABILITIES) if (src[k]) out.add(k);
    return out;
}

/** The context bound of the candidate, in tokens: the deployment's limit, else the model's context. */
function candidateContext(c) {
    const limits = c && c.limits;
    if (limits && limits.context_tokens != null) return Number(limits.context_tokens);
    const m = c && (c.model || c.model_info);
    if (m && m.context != null) return Number(m.context);
    if (m && m.context_window != null) return Number(m.context_window);
    return null;
}

/** The quality evidence for a candidate: { p_success, confidence, samples, source }. */
function evidenceOf(evidence, id) {
    if (!evidence) return null;
    if (evidence instanceof Map) return evidence.get(id) || null;
    return evidence[id] || null;
}

/**
 * The chance a request succeeds on a candidate, from optional quality evidence, and how much that evidence may
 * be trusted. Sparse evidence (few observations, or no confidence given) is MARKED, not trusted: the probability
 * is pulled toward the neutral prior and the candidate may not win on quality alone.
 *
 * The evidence is `{ p_success, confidence, samples }`:
 *  - `p_success` in (0, 1]: the measured chance the request succeeds there;
 *  - `confidence` in (0, 1]: how much the measurement may be trusted (0.5 = a prior, 1 = a full measurement);
 *  - `samples`: how many observations the measurement rests on.
 */
function qualityOf(ev, { prior = 0.9, floor = SPARSE_SAMPLE_COUNT } = {}) {
    if (!ev) return { p_success: prior, confidence: 0, samples: 0, sparse: true, source: 'prior' };
    const p = Number(ev.p_success);
    const conf = Number(ev.confidence);
    const samples = Number(ev.samples || 0);
    const sparse = !Number.isFinite(conf) || conf <= 0 || samples < floor;
    if (!Number.isFinite(p) || p <= 0) return { p_success: 0, confidence: 0, samples, sparse: true, source: ev.source || 'evidence' };
    // A trusted measurement is used as it is; a sparse one is pulled toward the prior, so it cannot dominate.
    const trust = sparse ? 0 : Math.min(1, Math.max(0, conf));
    const blended = trust > 0 ? trust * p + (1 - trust) * prior : prior;
    return {
        p_success: Math.max(0, Math.min(1, blended)),
        confidence: sparse ? 0 : trust,
        samples,
        sparse,
        source: ev.source || (sparse ? 'sparse_evidence' : 'evidence'),
    };
}

/**
 * The hard gates of the AI Exchange. Each returns a reason when the candidate may not run the workload, or null.
 * The order is the order of the reasons an operator reads: what it runs, who may serve it, what may see the
 * request, what it can do, what it costs.
 */
function aiExcluded(req, c, ctx) {
    const id = candidateId(c);

    // 1. The exact artifact: a pinned model id is never substituted (decision D3).
    const exact = req.exact_artifact || req.artifact_id || req.exact_model;
    if (exact) {
        const model = candidateModel(c);
        const artifact = String(c.artifact_id || '');
        if (model !== exact && artifact !== exact) return `exact model requested (${exact})`;
    }

    // 2. The commercial right: a paid managed route needs OWN_DEPLOYMENT or AUTHORIZED_WHOLESALE (decision D3).
    const access = candidateAccess(c);
    const paid = c.paid_managed === true || req.paid_managed === true;
    if (paid) {
        if (!access) return 'no recorded commercial right';
        if (!PAID_PROVIDER_ACCESS.has(access)) return `commercial right ${access} may not serve a paid route`;
    } else if (access && !PAID_PROVIDER_ACCESS.has(access) && req.allow_restricted === true) {
        return `commercial right ${access} is restricted`;
    }

    // 3. The privacy / trust class: the request may not reach a looser class than the workload allows.
    if (req.privacy_class) {
        const allowed = PRIVACY_CLASSES.filter((p) => PRIVACY_CLASSES.indexOf(p) <= PRIVACY_CLASSES.indexOf(req.privacy_class));
        const have = candidatePrivacy(c);
        if (!allowed.includes(have)) return `privacy class ${have} is not within ${req.privacy_class}`;
    }
    if (req.trust && req.trust.length) {
        const tier = c.trust_tier;
        if (tier && !req.trust.includes(tier)) return `trust tier ${tier} is not allowed`;
    }

    // 4. The capabilities: tools, json, vision, stream.
    const wanted = req.capabilities || [];
    const have = candidateCapabilities(c);
    for (const k of wanted) {
        if (!MODEL_CAPABILITIES.includes(k)) continue;      // a non-model capability is the caller's own gate
        if (!have.has(k)) return `lacks ${k}`;
    }

    // 5. The context bound.
    if (req.context_tokens != null) {
        const ctxTokens = candidateContext(c);
        if (ctxTokens != null && ctxTokens < req.context_tokens) return `context ${ctxTokens} tokens is under ${req.context_tokens}`;
    }

    // 6. The health of the deployment.
    const status = c.status || (c.health && c.health.healthy === false ? 'offline' : null);
    if (status && !['ready', 'warming', 'degraded'].includes(status)) return `status ${status}`;
    if (c.health && c.health.healthy === false) return 'not healthy';

    return null;
}

/**
 * The cost ceiling: the expected cost of the request on this candidate, in nano-USD, against the ceiling.
 * A candidate without a rate is never assumed free: it is rejected, not priced at zero.
 */
function aiCostExcluded(req, c, ctx) {
    const ceiling = req.max_cost_nano_usd != null ? req.max_cost_nano_usd : (req.max_cost_usd != null ? null : null);
    if (ceiling == null && req.max_cost_usd == null) return null;
    const usage = ctx.usage || {};
    const rates = ctx.ratesFor(c);
    if (!rates) return 'no rate: the cost is unknown';
    const cost = expectedCostNano(usage, rates);
    const limit = req.max_cost_nano_usd != null ? nanoUsd(req.max_cost_nano_usd) : BigInt(Math.ceil(req.max_cost_usd * 1e9));
    if (cost > limit) return `expected cost ${formatNanoUsd(cost)} nano-USD is over the ${formatNanoUsd(limit)} ceiling`;
    return null;
}

/**
 * planAi(requirements, candidates, opts) → the AI Exchange answer.
 *
 *   const r = planAi(
 *       { exact_artifact: 'qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9', capabilities: ['tools'], paid_managed: true,
 *         max_cost_nano_usd: '50000', objective: 'cheapest' },
 *       candidates,                         // ai.inference-deployment@1 + its ai.model@1 entry
 *       { enabled: true, usage: { input_tokens: 800, output_tokens: 400 },
 *         evidence: { 'dep-qwen-9b-us-east-001': { p_success: 0.95, confidence: 0.9, samples: 120 } },
 *         rates: { 'dep-qwen-9b-us-east-001': { input_nano_usd_per_m: '3000', ... } },
 *         current: 'dep-qwen-9b-us-east-001', now: Date.now() },
 *   );
 *   // → { chosen, rejected: [{ id, reason }], objective, estimate, explain: { rejected, objective, ... } }
 *
 * `opts.enabled` is the flag: it is off by default, and without it the planner answers
 * `{ chosen: null, rejected: [], objective, disabled: true, explain: { objective, disabled: true } }`.
 *
 * Hysteresis and affinity are the ones plan() has: `current` (the deployment the workload runs on now) is kept
 * unless another candidate is clearly better (`minGain`, default 0.15), and `affinity` (a map of deployment id to a
 * stickiness bonus, 0..1) keeps a workload on the deployment it is warm on.
 */
function planAi(req, candidates, opts = {}) {
    const {
        enabled = false, now = Date.now(), current = null, minGain = 0.15,
        usage = {}, evidence = null, rates = null, pFloor = DEFAULT_P_FLOOR,
        affinity = null, affinityGain = 0.05, prior = 0.9, sparseSampleFloor = SPARSE_SAMPLE_COUNT,
    } = opts;
    const objective = req.objective || 'cheapest';
    const list = Array.isArray(candidates) ? candidates : [];

    if (!enabled) {
        return {
            chosen: null,
            rejected: [],
            objective,
            disabled: true,
            explain: { objective, disabled: true, rejected: [], candidates: [], decided_at: new Date(now).toISOString() },
        };
    }

    const ctx = {
        now, usage,
        ratesFor: (c) => {
            const id = candidateId(c);
            if (rates instanceof Map) return rates.get(id) || null;
            if (rates && typeof rates === 'object') return rates[id] || null;
            return c.retail_rate || c.rate || null;
        },
    };

    const rejected = [];
    const seen = new Set();
    const reject = (id, reason) => {
        if (seen.has(id)) return;
        seen.add(id);
        rejected.push({ id, reason: safeReason(reason) });
    };

    const scored = [];
    for (const c of list) {
        const id = candidateId(c);
        if (!id) continue;
        const why = aiExcluded(req, c, ctx) || aiCostExcluded(req, c, ctx);
        if (why) { reject(id, why); continue; }
        const ratesForThis = ctx.ratesFor(c);
        if (!ratesForThis) { reject(id, 'no rate: the cost is unknown'); continue; }
        const expected = expectedCostNano(usage, ratesForThis);
        const ev = evidenceOf(evidence, id);
        const q = qualityOf(ev, { prior, floor: sparseSampleFloor });
        if (q.p_success <= 0) { reject(id, 'no chance of success'); continue; }
        const cps = costPerSuccessNano(expected, q.p_success, pFloor);
        if (cps == null) { reject(id, 'no chance of success'); continue; }
        scored.push({
            id,
            model: candidateModel(c),
            expected_cost_nano_usd: expected,
            p_success: q.p_success,
            confidence: q.confidence,
            samples: q.samples,
            sparse_evidence: q.sparse,
            evidence_source: q.source,
            cost_per_success_nano_usd: cps,
            latency_ms: c.latency_ms != null ? Number(c.latency_ms) : null,
        });
    }

    if (!scored.length) {
        return {
            chosen: null, rejected, objective,
            explain: { objective, rejected, candidates: [], decided_at: new Date(now).toISOString(), no_eligible_candidate: true },
        };
    }

    // Rank by the cost of one success. A candidate whose evidence is sparse may not win on a thin measurement:
    // it is compared as if its probability were the prior, so a sparse candidate only wins on price.
    //
    // The objective says how the cost per success is weighed against the other things the caller cares about
    // (PLAN §E): `cheapest` is the cost per success alone; `fastest` prefers the latency; `best` prefers the
    // measured quality; `balanced` weighs cost and latency; `exact` is a pinned artifact (the exact gate already
    // left one candidate); `private` is a trust constraint (the privacy gate already left the rest).
    const priorCost = (s) => costPerSuccessNano(s.expected_cost_nano_usd, prior, pFloor);
    const costOf = (s) => (s.sparse_evidence ? priorCost(s) : s.cost_per_success_nano_usd);
    const qualityOf_ = (s) => (s.sparse_evidence ? prior : s.p_success);
    const latencyOf_ = (s) => (s.latency_ms == null ? null : Number(s.latency_ms));

    // The scales the objective weighs against each other: the cost per success, the latency and the quality.
    const lats = scored.map(latencyOf_).filter((x) => x != null);
    const maxLat = lats.length ? lats.reduce((m, l) => (l > m ? l : m), 0) : 0;

    const weights = {
        cheapest: { cost: 1, latency: 0, quality: 0 },
        balanced: { cost: 0.7, latency: 0.3, quality: 0 },
        fastest: { cost: 0.2, latency: 0.8, quality: 0 },
        best: { cost: 0.2, latency: 0, quality: 0.8 },
        exact: { cost: 1, latency: 0, quality: 0 },
        private: { cost: 1, latency: 0, quality: 0 },
    }[objective] || { cost: 1, latency: 0, quality: 0 };

    const ranked = scored.slice().sort((a, b) => {
        const ca = costOf(a); const cb = costOf(b);
        if (ca !== cb && (weights.cost > 0)) {
            // The cost per success decides unless another objective outweighs it.
            const latA = latencyOf_(a); const latB = latencyOf_(b);
            const latGap = (latA != null && latB != null && maxLat > 0) ? (latA - latB) / maxLat : 0;
            const qGap = qualityOf_(a) - qualityOf_(b);
            const advantage = weights.latency * latGap - weights.quality * qGap;
            if (advantage > 0.05) return 1;
            if (advantage < -0.05) return -1;
            return ca < cb ? -1 : 1;
        }
        const latA = latencyOf_(a); const latB = latencyOf_(b);
        if (latA != null && latB != null && latA !== latB) return latA - latB;
        return a.id < b.id ? -1 : 1;
    });

    let best = ranked[0];
    const reasons = [];
    // Affinity: a workload stays on the deployment it is warm on. It is a tie-breaker, never a gate.
    if (affinity) {
        const bonus = (id) => Number((affinity instanceof Map ? affinity.get(id) : affinity[id]) || 0);
        const warm = ranked.find((s) => bonus(s.id) > 0);
        if (warm && warm !== best) {
            const cb = costOf(best); const cw = costOf(warm);
            const gap = cb === 0n ? 0 : Number((cb - cw) * 1000n / (cb || 1n)) / 1000;
            if (gap <= Number(affinityGain)) { best = warm; reasons.push(`stays on ${warm.id}: it is warm (affinity)`); }
        }
    }
    // Hysteresis: the current placement is kept unless another one is clearly better.
    const cur = current && scored.find((s) => s.id === current);
    if (cur && cur !== best) {
        const cb = costOf(best); const cc = costOf(cur);
        const gain = cc > 0n ? Number((cc - cb) * 1000n / cc) / 1000 : 0;
        if (gain < minGain) { best = cur; reasons.push(`stays on ${cur.id}: the best alternative is only ${(gain * 100).toFixed(1)}% better`); }
    } else if (current && !cur) {
        reasons.push(`${current} is no longer eligible: moved`);
    }
    if (best.sparse_evidence) reasons.push(`${best.id} has sparse quality evidence: it is priced as if it were at the prior`);
    reasons.push(`objective ${objective}: the expected cost per success`);

    const chosen = scored.find((s) => s.id === best.id);
    for (const s of scored) {
        if (s.id === chosen.id) continue;
        if (!seen.has(s.id)) reject(s.id, 'a higher expected cost per success');
    }

    const estimate = {
        charge_nano_usd: formatNanoUsd(chosen.expected_cost_nano_usd),
        input_tokens: Math.max(0, Math.floor(Number(usage.input_tokens) || 0)),
        cached_read_tokens: Math.max(0, Math.floor(Number(usage.cached_read_tokens) || 0)),
        cache_write_tokens: Math.max(0, Math.floor(Number(usage.cache_write_tokens) || 0)),
        output_tokens: Math.max(0, Math.floor(Number(usage.output_tokens) || 0)),
    };

    return {
        chosen: chosen.id,
        rejected,
        objective,
        estimate,
        explain: {
            objective,
            rejected,
            reasons,
            candidates: scored.map((s) => ({
                id: s.id,
                model: s.model,
                expected_cost_nano_usd: formatNanoUsd(s.expected_cost_nano_usd),
                cost_per_success_nano_usd: formatNanoUsd(s.cost_per_success_nano_usd),
                p_success: Number(s.p_success.toFixed(6)),
                confidence: Number(s.confidence.toFixed(6)),
                samples: s.samples,
                sparse_evidence: s.sparse_evidence,
                evidence_source: s.evidence_source,
                selected: s.id === chosen.id,
            })),
            decided_at: new Date(now).toISOString(),
        },
    };
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
    planAi, aiExcluded, qualityOf, safeReason,
    TRUST_CLASSES, TRUST_ORDER, DEFAULT_TRUST,
    PAID_PROVIDER_ACCESS, PROVIDER_ACCESS, PRIVACY_CLASSES, MODEL_CAPABILITIES,
    DEFAULT_P_FLOOR, SPARSE_SAMPLE_COUNT,
};
