'use strict';
/**
 * openvibe-sdk/govern — one resource-governance layer for every product (roadmap WS-Z1, decision 40): weighted cost
 * units (common.resource-cost@1), quotas per subject and tier over several windows, reserve → commit | release so
 * a failed job gives its cost back, idempotency keys so a retried charge counts once, and concurrency leases.
 * Valkey holds the counters across processes and hosts; without Valkey they live in this process (tests, one
 * process).
 *
 *   const gov = createGovernor({ policy, valkey, now });
 *   const r = await gov.reserve({ subject: 'user:usr_…', tier: 'user', unit: 'browser-second', amount: 30, key: 'run_1:step_2' });
 *   if (!r.ok) → 429 with r.retryAfterS (r.window, r.limit, r.used)
 *   await gov.commit(r.id, 12.5);    // the real amount; the difference goes back
 *   await gov.release(r.id);         // the work never happened
 *   const lease = await gov.lease({ subject, kind: 'browser', max: 2, ttlMs: 60000 });   // { ok, id, release() }
 *
 * policy: { [unit]: { [tier]: { minute?, hour?, day?, month? } } } — a missing tier or window is unlimited, 0
 * refuses. Contracts publishes the numbers so pages and the API read the same ones (WS-Z1 task 5).
 */
const crypto = require('crypto');

const WINDOWS = { minute: 60e3, hour: 3600e3, day: 86400e3, month: 30 * 86400e3 };
const UNITS = ['browser-second', 'ai-token', 'ai-usd', 'gpu-second', 'video-minute', 'bandwidth-byte', 'storage-byte-day', 'event',
    'watch-check', 'bot-control-second', 'job-run', 'upload-byte', 'download-byte'];

function windowsFor(policy, unit, tier, t) {
    const p = (policy[unit] && policy[unit][tier]) || null;
    if (!p) return [];
    return Object.keys(WINDOWS).filter((w) => p[w] != null).map((w) => {
        const len = WINDOWS[w]; const start = Math.floor(t / len) * len;
        return { w, limit: Number(p[w]), start, len, ttlMs: start + len - t };
    });
}

// ── Stores ───────────────────────────────────────────────────────────────────

function memoryStore() {
    const counters = new Map(); const reservations = new Map(); const leases = new Map();
    const sweep = (t) => { for (const [k, v] of counters) if (v.until <= t) counters.delete(k); for (const [k, v] of reservations) if (v.until <= t) reservations.delete(k); };
    return {
        async reserve(id, keys, amount, ttlMs, t) {
            sweep(t);
            if (reservations.has(id)) return { ok: true, replay: true, reservation: reservations.get(id) };
            for (const k of keys) {
                const c = counters.get(k.key);
                if ((c ? c.used : 0) + amount > k.limit) return { ok: false, window: k.w, limit: k.limit, used: c ? c.used : 0, retryMs: k.ttlMs };
            }
            for (const k of keys) {
                const c = counters.get(k.key) || { used: 0, until: t + k.ttlMs };
                c.used += amount; counters.set(k.key, c);
            }
            const r = { amount, keys: keys.map((k) => k.key), until: t + ttlMs };
            reservations.set(id, r);
            return { ok: true, reservation: r };
        },
        async settle(id, actual, t) {
            sweep(t);
            const r = reservations.get(id);
            if (!r) return false;
            const delta = actual == null ? -r.amount : actual - r.amount;
            for (const key of r.keys) { const c = counters.get(key); if (c) c.used = Math.max(0, c.used + delta); }
            reservations.delete(id);
            return true;
        },
        async used(key, t) { sweep(t); const c = counters.get(key); return c ? c.used : 0; },
        async lease(key, id, max, ttlMs, t) {
            const m = leases.get(key) || new Map();
            for (const [lid, until] of m) if (until <= t) m.delete(lid);
            if (m.size >= max) return false;
            m.set(id, t + ttlMs); leases.set(key, m);
            return true;
        },
        async unlease(key, id) { const m = leases.get(key); if (m) m.delete(id); },
    };
}

const RESERVE = `
-- KEYS: reservation key, then one counter key per window. ARGV: amount, reservation ttl ms, then limit, ttl ms per window.
if redis.call('EXISTS', KEYS[1]) == 1 then return {1, 1} end
local amount = tonumber(ARGV[1])
for i = 2, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[3 + (i - 2) * 2])
  if used + amount > limit then return {0, i - 1, tostring(used), ARGV[4 + (i - 2) * 2]} end
end
for i = 2, #KEYS do
  redis.call('INCRBYFLOAT', KEYS[i], amount)
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[4 + (i - 2) * 2]) + 5000)
end
local keys = {}
for i = 2, #KEYS do keys[#keys + 1] = KEYS[i] end
redis.call('SET', KEYS[1], cjson.encode({ amount = amount, keys = keys }), 'PX', tonumber(ARGV[2]))
return {1, 0}`;
const SETTLE = `
-- KEYS: reservation key. ARGV: the actual amount, or '' to release it all. Moves each counter the reservation
-- charged by (actual - reserved), never below 0, and ends the reservation. Any process may settle it.
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local r = cjson.decode(raw)
local delta = -r.amount
if ARGV[1] ~= '' then delta = tonumber(ARGV[1]) - r.amount end
redis.call('DEL', KEYS[1])
for _, k in ipairs(r.keys) do
  local v = tonumber(redis.call('INCRBYFLOAT', k, delta))
  if v < 0 then redis.call('SET', k, '0', 'KEEPTTL') end
end
return 1`;
const LEASE = `
-- KEYS: lease set. ARGV: id, max, ttl ms, now ms.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[4]) + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 5000)
return 1`;

function valkeyStore(valkey) {
    const c = valkey.client;
    if (typeof c.ovGovReserve !== 'function') {
        c.defineCommand('ovGovReserve', { lua: RESERVE });
        c.defineCommand('ovGovSettle', { numberOfKeys: 1, lua: SETTLE });
        c.defineCommand('ovGovLease', { numberOfKeys: 1, lua: LEASE });
    }
    const rkey = (id) => valkey.key('gov', 'res', id);
    return {
        async reserve(id, keys, amount, ttlMs) {
            const args = [String(amount), String(ttlMs)];
            for (const k of keys) args.push(String(k.limit), String(Math.max(1, Math.ceil(k.ttlMs))));
            const r = await c.ovGovReserve(1 + keys.length, rkey(id), ...keys.map((k) => valkey.key('gov', k.key)), ...args);
            if (Number(r[0]) === 1) return { ok: true, replay: Number(r[1]) === 1 };
            const k = keys[Number(r[1]) - 1];
            return { ok: false, window: k.w, limit: k.limit, used: Number(r[2]), retryMs: Number(r[3]) };
        },
        async settle(id, actual) { return Number(await c.ovGovSettle(rkey(id), actual == null ? '' : String(actual))) === 1; },
        async used(key) { return Number((await c.get(valkey.key('gov', key))) || 0); },
        async lease(key, id, max, ttlMs, t) { return Number(await c.ovGovLease(valkey.key('gov', 'lease', key), id, String(max), String(ttlMs), String(t))) === 1; },
        async unlease(key, id) { await c.zrem(valkey.key('gov', 'lease', key), id); },
    };
}

// ── The governor ─────────────────────────────────────────────────────────────

/**
 * `service` names the service that spends ('openvibe.ai'); every usage record carries it (platform.usage-sample@1 requires it).
 * `provider`, `resource` and `region` are defaults for the records; reserve() can override each.
 */
function createGovernor({ policy = {}, valkey = null, now = () => Date.now(), reservationTtlMs = 6 * 3600e3, onRefused = null, onUsage = null,
    service = null, provider = null, resource = null, region = null, log = console } = {}) {
    const store = valkey ? valkeyStore(valkey) : memoryStore();
    if (!service) log.warn('[govern] createGovernor() without `service`: usage records lack the service platform.usage-sample@1 requires');

    async function reserve({ subject, tier = 'user', unit, amount, key, project = null, operation, provider: prov, resource: res, region: reg, trace_id, route_epoch }) {
        if (!UNITS.includes(unit)) throw new TypeError(`govern: unknown unit ${unit}`);
        if (!(amount >= 0)) throw new TypeError('govern: amount must be ≥ 0');
        if (!key || String(key).length < 8) throw new TypeError('govern: an idempotency key of 8+ characters is required');
        const t = now();
        const id = crypto.createHash('sha256').update(`${subject}\u0000${unit}\u0000${key}`).digest('base64url').slice(0, 32);
        const scope = project ? `${project}:${subject}` : subject;
        const keys = windowsFor(policy, unit, tier, t).map((w) => ({ ...w, key: `${unit}:${w.w}:${w.start}:${scope}` }));
        const r = await store.reserve(id, keys, Number(amount), reservationTtlMs, t);
        if (!r.ok) {
            const out = { ok: false, unit, window: r.window, limit: r.limit, used: r.used, retryAfterS: Math.max(1, Math.ceil(r.retryMs / 1000)) };
            if (onRefused) onRefused({ subject, tier, unit, amount, ...out });
            return out;
        }
        if (onUsage && !r.replay) {
            // A platform.usage-sample@1 reading: pass-through only, no money fields (rating is Billing's).
            const record = { id, idempotency_key: key, service, project, subject, resource: res ?? resource, provider: prov ?? provider, region: reg ?? region,
                operation: operation || 'reserve', quantity: Number(amount), unit, at: new Date(t).toISOString(), route_epoch, trace_id, source: 'openvibe-sdk/govern' };
            for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
            onUsage(record);
        }
        return { ok: true, id, replay: Boolean(r.replay) };
    }

    /** The real amount used: counters move by (actual − reserved); the reservation ends. False when it had already ended. */
    async function commit(id, actual) {
        if (!(actual >= 0)) throw new TypeError('govern: commit needs the actual amount (≥ 0)');
        return await store.settle(id, Number(actual), now());
    }

    /** The work never happened: everything reserved goes back. */
    async function release(id) {
        return await store.settle(id, null, now());
    }

    /** Used so far in each window of a unit, for a subject and tier (for dashboards and the limits page). */
    async function usage({ subject, tier = 'user', unit, project = null }) {
        const t = now(); const scope = project ? `${project}:${subject}` : subject;
        const out = {};
        for (const w of windowsFor(policy, unit, tier, t)) out[w.w] = { used: await store.used(`${unit}:${w.w}:${w.start}:${scope}`, t), limit: w.limit };
        return out;
    }

    /** At most `max` at once for (subject, kind); a lease expires by itself after ttlMs. */
    async function lease({ subject, kind, max, ttlMs = 60e3 }) {
        const id = crypto.randomBytes(9).toString('base64url');
        const key = `${kind}:${subject}`;
        const ok = await store.lease(key, id, max, ttlMs, now());
        return ok ? { ok: true, id, release: () => store.unlease(key, id) } : { ok: false, retryAfterS: Math.max(1, Math.ceil(ttlMs / 1000)) };
    }

    return { reserve, commit, release, usage, lease, policy };
}

module.exports = { createGovernor, WINDOWS, UNITS };
