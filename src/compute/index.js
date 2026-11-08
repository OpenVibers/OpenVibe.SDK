'use strict';
const { plan } = require('../placement');
const STRATEGIES = ['automatic', 'cheapest', 'fastest', 'private', 'own'];
const TIERS = ['own', 'home', 'dedicated', 'community', 'partner'];
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Pure policy over trusted inventory, not over client-supplied machine claims. Money is per hour. */
function choose(request, machines, pool = {}, { now = Date.now(), current = null } = {}) {
    const strategy = request.strategy || pool.strategy || 'automatic';
    if (!STRATEGIES.includes(strategy)) throw new TypeError('unknown compute strategy');
    const ram = Math.max(request.kind === 'desktop' ? 2048 : 300, Number(request.ram_mb) || 0);
    const ceiling = Math.min(...[request.max_hourly, pool.max_hourly].filter(finite), Infinity);
    const rejected = [];
    const eligible = machines.filter((m) => {
        let why;
        if (!TIERS.includes(m.tier)) why = 'unknown tier';
        else if (m.tier === 'own' && (!request.owner || m.owner !== request.owner)) why = 'not your machine';
        else if (strategy === 'own' && m.tier !== 'own') why = 'own machines only';
        else if (strategy === 'private' && !['own', 'home', 'dedicated'].includes(m.tier)) why = 'OpenVibe or own machines only';
        else if (request.machine && m.id !== request.machine) why = 'another machine requested';
        else if (m.health !== 'up' || m.draining) why = 'unhealthy or draining';
        else if (request.region && m.region !== request.region) why = 'outside required region';
        else if (request.gpu_mb && !(m.gpu_mb >= request.gpu_mb)) why = 'insufficient GPU memory';
        else if (!(m.free_ram_mb >= ram) || !(m.free_slots > 0)) why = 'no capacity';
        else if (m.tier === 'home' && request.public_egress && m.egress !== 'ovh-tunnel') why = 'home egress is not protected';
        else if (!finite(m.hourly)) why = 'unknown hourly cost';
        else if (m.currency !== (pool.currency || 'USD')) why = 'different currency';
        else if (m.hourly > ceiling) why = 'over hourly ceiling';
        else if (strategy === 'automatic' && (m.queue_ms || 0) > (pool.target_wait_ms ?? 30000)) why = 'queue exceeds target';
        if (why) { rejected.push({ id: m.id, reason: why }); return false; }
        return true;
    });
    let choices = eligible;
    if (strategy === 'automatic' && choices.length) {
        const tier = TIERS.find((t) => choices.some((m) => m.tier === t));
        choices = choices.filter((m) => m.tier === tier);
    }
    // Cost/latency remain the shared placement planner's responsibility. Best-fit RAM and a session ceiling
    // provide deterministic packing within equal-price/latency choices without changing the financial score.
    choices = choices.slice().sort((a, b) => (a.free_ram_mb - ram) - (b.free_ram_mb - ram) || (a.sessions || 0) - (b.sessions || 0) || a.id.localeCompare(b.id));
    const offers = choices.map((m) => ({ offer_id: m.id, trust: 'first-party', health: { status: 'up' },
        pricing: { marginal_usd_per_unit: m.hourly }, latency_ms: finite(m.latency_ms) ? { p95: m.latency_ms } : {},
    }));
    const p = plan({ objective: strategy === 'fastest' ? 'lowest-latency' : 'cheapest' }, offers, { now, current, minGain: pool.min_gain ?? 0.15 });
    const chosen = choices.find((m) => m.id === p.selected) || null;
    return { strategy, selected: chosen && chosen.id, tier: chosen && chosen.tier, hourly: chosen && chosen.hourly,
        currency: pool.currency || 'USD', reasons: [...p.reasons, ...(strategy === 'automatic' && chosen ? [`first eligible tier: ${chosen.tier}`] : [])],
        rejected, switched: Boolean(current && current !== p.selected), decided_at: new Date(now).toISOString() };
}

/** Build a new desired state; never mutate input or call a provider. Observations must be authoritative. */
function scale(pool, machines, waiting, { now = Date.now() } = {}) {
    const ram = Math.max(pool.kind === 'desktop' ? 2048 : 300, pool.measured_peak_ram_mb || 0);
    const target = pool.target_wait_ms ?? 30000;
    const warm = Math.max(0, pool.min_warm || 0);
    const grace = pool.idle_grace_ms ?? 600000;
    const max = Math.max(warm, pool.max_machines ?? 10);
    const live = machines.filter((m) => m.state !== 'released');
    const ready = live.filter((m) => m.health === 'up' && !m.draining);
    const slots = (m) => Math.max(0, Math.min(m.free_slots || 0, Math.floor((m.free_ram_mb || 0) / ram)));
    const due = waiting.filter((s) => now - s.created_at >= target);
    const capacity = ready.reduce((n, m) => n + slots(m), 0);
    const pending = live.filter((m) => m.state === 'provisioning').length;
    const need = Math.max(warm - ready.length - pending, Math.ceil(Math.max(0, due.length - capacity) / Math.max(1, pool.slots_per_machine || 1)) - pending);
    const actions = [];
    for (let n = 0; n < Math.min(need, max - live.length); n++) actions.push({ action: 'provision', reason: due.length > capacity ? 'queue wait exceeded target' : 'minimum warm pool' });
    let remaining = ready.length;
    for (const m of live.slice().sort((a, b) => (b.hourly || 0) - (a.hourly || 0))) {
        if (m.draining && m.sessions === 0) actions.push({ action: 'release', id: m.id, reason: 'drain completed' });
        else if (!m.draining && m.managed && m.sessions === 0 && finite(m.idle_since) && now - m.idle_since >= grace && remaining > warm && !waiting.length) {
            actions.push({ action: 'drain', id: m.id, reason: 'idle grace elapsed' }); remaining--;
        }
    }
    return { actions, ram_per_session_mb: ram, waiting: waiting.length, overdue: due.length, free_slots: capacity };
}

/** Exact decimal money, in millionths of the quote currency; reject negatives, NaN and excess precision. */
function micros(value) {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
    if (!m) throw new TypeError('money must be a nonnegative decimal with at most six places');
    return BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0'));
}
function charge(hourlyMicros, milliseconds, quantumSeconds = 1) {
    if (!finite(milliseconds) || !finite(quantumSeconds) || !quantumSeconds) throw new TypeError('invalid billing duration');
    const seconds = BigInt(Math.ceil(milliseconds / (quantumSeconds * 1000)) * quantumSeconds);
    return (BigInt(hourlyMicros) * seconds + 3599n) / 3600n;
}
module.exports = { choose, scale, micros, charge, STRATEGIES, TIERS, ...require('./providers') };
