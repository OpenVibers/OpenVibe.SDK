'use strict';
/**
 * openvibe-sdk/queue — durable background jobs on Valkey streams (ADR-035), in-process without Valkey (tests).
 *
 *   const q = createQueue({ valkey, name: 'thumbnails' });
 *   await q.add({ objectId }, { delayMs: 0, attempts: 5, id: `thumb:${objectId}` });
 *   const worker = q.process(async (data, job) => { … }, { concurrency: 4, visibilityMs: 60000 });
 *   await worker.stop();                       // finishes running jobs first
 *
 * At-least-once: a job leaves the stream only after its handler resolves. A worker that dies mid-job leaves it
 * pending, and another worker reclaims it after visibilityMs. A failure retries with exponential backoff
 * (1 s, 2 s, 4 s … capped at 5 min), and after `attempts` tries the job lands in the dead-letter stream with its
 * last error (`q.dead()`). `id` dedupes adds for 24 hours. Handlers must therefore be idempotent. Any number of
 * workers on any number of hosts share one queue through its consumer group.
 */
const crypto = require('crypto');
const os = require('os');

const backoff = (attempt) => Math.min(300000, 1000 * 2 ** (attempt - 1));
const uid = () => crypto.randomBytes(6).toString('hex');

// Move due delayed jobs into the stream. Member: "<uid>|<attempt>|<max>|<json>" (no JSON re-encoding in Lua).
const PROMOTE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 200)
for _, m in ipairs(due) do
  local p1 = string.find(m, '|', 1, true)
  local p2 = string.find(m, '|', p1 + 1, true)
  local p3 = string.find(m, '|', p2 + 1, true)
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'd', string.sub(m, p3 + 1), 'a', string.sub(m, p1 + 1, p2 - 1), 'm', string.sub(m, p2 + 1, p3 - 1))
  redis.call('ZREM', KEYS[1], m)
end
return #due`;

function fieldsOf(arr) { const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; }

function createQueue({ valkey = null, name, group = 'workers', maxLen = 100000, log = console } = {}) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(String(name || ''))) throw new TypeError('queue: name must be a short lowercase identifier');
    return valkey ? valkeyQueue(valkey, name, group, maxLen, log) : memoryQueue(name, log);
}

function valkeyQueue(valkey, name, group, maxLen, log) {
    const c = valkey.client;
    const key = valkey.key('q', name);
    const delayed = valkey.key('q', name, 'delayed');
    const dead = valkey.key('q', name, 'dead');
    const dedupe = (id) => valkey.key('q', name, 'id', id);
    if (typeof c.ovQueuePromote !== 'function') c.defineCommand('ovQueuePromote', { numberOfKeys: 2, lua: PROMOTE });

    async function ensureGroup() {
        try { await c.xgroup('CREATE', key, group, '0', 'MKSTREAM'); } catch (err) { if (!/BUSYGROUP/.test(err.message)) throw err; }
    }

    async function add(data, { delayMs = 0, attempts = 5, id = null } = {}) {
        if (id && (await c.set(dedupe(id), '1', 'EX', 86400, 'NX')) !== 'OK') return null;
        const json = JSON.stringify(data === undefined ? null : data);
        if (delayMs > 0) {
            await c.zadd(delayed, Date.now() + delayMs, `${uid()}|1|${attempts}|${json}`);
            return 'delayed';
        }
        return c.xadd(key, 'MAXLEN', '~', maxLen, '*', 'd', json, 'a', '1', 'm', String(attempts));
    }

    function process(handler, { concurrency = 4, visibilityMs = 60000, blockMs = 5000 } = {}) {
        const consumer = `${os.hostname()}:${global.process.pid}:${uid()}`;
        const reader = valkey.duplicate();
        let stopped = false; let active = 0; let wake = null;
        const stats = { done: 0, failed: 0, retried: 0, dead: 0 };

        async function run(id, raw) {
            const f = fieldsOf(raw);
            const attempt = Number(f.a) || 1; const max = Number(f.m) || 5;
            active++;
            try {
                await handler(JSON.parse(f.d), { id, attempt, queue: name });
                await c.multi().xack(key, group, id).xdel(key, id).exec();
                stats.done++;
            } catch (err) {
                stats.failed++;
                const reason = String((err && err.message) || err).slice(0, 500);
                const m = c.multi();
                if (attempt >= max) { m.xadd(dead, 'MAXLEN', '~', 10000, '*', 'd', f.d, 'a', String(attempt), 'e', reason, 'at', new Date().toISOString()); stats.dead++; log.warn(`[queue ${name}] job ${id} dead after ${attempt} attempts: ${reason}`); }
                else { m.zadd(delayed, Date.now() + backoff(attempt), `${uid()}|${attempt + 1}|${max}|${f.d}`); stats.retried++; }
                await m.xack(key, group, id).xdel(key, id).exec().catch((e) => log.warn(`[queue ${name}] could not requeue ${id}: ${e.message}`));
            } finally {
                active--;
                if (wake) { const w = wake; wake = null; w(); }
            }
        }

        async function loop() {
            await ensureGroup();
            while (!stopped) {
                const free = concurrency - active;
                if (free <= 0) { await new Promise((r) => { wake = r; }); continue; }
                let res;
                try { res = await reader.xreadgroup('GROUP', group, consumer, 'COUNT', free, 'BLOCK', blockMs, 'STREAMS', key, '>'); } catch (err) {
                    if (stopped) break;
                    if (/NOGROUP/.test(err.message)) { await ensureGroup().catch(() => {}); continue; }
                    log.warn(`[queue ${name}] read: ${err.message}`);
                    await new Promise((r) => setTimeout(r, 1000));
                    continue;
                }
                if (!res) continue;
                for (const [, entries] of res) for (const [id, raw] of entries) run(id, raw);
            }
        }

        const promote = setInterval(() => { c.ovQueuePromote(delayed, key, String(Date.now()), String(maxLen)).catch(() => {}); }, 1000);
        const reclaim = setInterval(async () => {
            if (stopped || active >= concurrency) return;
            try {
                const [, entries] = await c.xautoclaim(key, group, consumer, visibilityMs, '0-0', 'COUNT', Math.max(1, concurrency - active));
                for (const [id, raw] of entries || []) if (raw) run(id, raw);
            } catch { /* the next tick tries again */ }
        }, Math.max(1000, Math.floor(visibilityMs / 2)));
        promote.unref(); reclaim.unref();
        const done = loop().catch((err) => log.error(`[queue ${name}] worker stopped: ${err.message}`));

        return {
            stats: () => ({ ...stats, active }),
            async stop(timeoutMs = 30000) {
                stopped = true;
                clearInterval(promote); clearInterval(reclaim);
                reader.disconnect();
                if (wake) { const w = wake; wake = null; w(); }
                const until = Date.now() + timeoutMs;
                while (active > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
                await done;
            },
        };
    }

    return {
        name, add, process,
        async stats() {
            const [len, del, dd] = await Promise.all([c.xlen(key).catch(() => 0), c.zcard(delayed), c.xlen(dead).catch(() => 0)]);
            let pending = 0;
            try { const p = await c.xpending(key, group); pending = Number(p[0]) || 0; } catch { /* no group yet */ }
            return { waiting: Math.max(0, len - pending), pending, delayed: del, dead: dd };
        },
        async dead(count = 50) {
            const rows = await c.xrevrange(dead, '+', '-', 'COUNT', count);
            return rows.map(([id, raw]) => { const f = fieldsOf(raw); return { id, data: JSON.parse(f.d), attempts: Number(f.a), error: f.e, at: f.at }; });
        },
    };
}

// ── In-process queue with the same behaviour (tests, single-process tools) ─────────────────
function memoryQueue(name, log) {
    const ready = []; const deadList = []; const seen = new Map(); const workers = new Set();
    let seq = 0;
    const kick = () => { for (const w of workers) w(); };
    function add(data, { delayMs = 0, attempts = 5, id = null } = {}) {
        if (id) { const t = seen.get(id); if (t && t > Date.now()) return Promise.resolve(null); seen.set(id, Date.now() + 86400000); }
        const job = { id: `m-${++seq}`, data: JSON.parse(JSON.stringify(data === undefined ? null : data)), attempt: 1, max: attempts };
        if (delayMs > 0) setTimeout(() => { ready.push(job); kick(); }, delayMs).unref();
        else { ready.push(job); kick(); }
        return Promise.resolve(delayMs > 0 ? 'delayed' : job.id);
    }
    function process(handler, { concurrency = 4, backoffMs = backoff } = {}) {
        let active = 0; let stopped = false;
        const stats = { done: 0, failed: 0, retried: 0, dead: 0 };
        const pump = () => {
            while (!stopped && active < concurrency && ready.length) {
                const job = ready.shift(); active++;
                Promise.resolve().then(() => handler(job.data, { id: job.id, attempt: job.attempt, queue: name })).then(() => { stats.done++; }, (err) => {
                    stats.failed++;
                    if (job.attempt >= job.max) { stats.dead++; deadList.push({ id: job.id, data: job.data, attempts: job.attempt, error: String((err && err.message) || err), at: new Date().toISOString() }); }
                    else { stats.retried++; const next = { ...job, attempt: job.attempt + 1 }; setTimeout(() => { ready.push(next); kick(); }, backoffMs(job.attempt)).unref(); }
                }).finally(() => { active--; pump(); });
            }
        };
        workers.add(pump); pump();
        return {
            stats: () => ({ ...stats, active }),
            async stop(timeoutMs = 30000) { stopped = true; workers.delete(pump); const until = Date.now() + timeoutMs; while (active > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10)); },
        };
    }
    void log;
    return {
        name, add, process,
        async stats() { return { waiting: ready.length, pending: 0, delayed: 0, dead: deadList.length }; },
        async dead(count = 50) { return deadList.slice(-count).reverse(); },
    };
}

module.exports = { createQueue, backoff };
