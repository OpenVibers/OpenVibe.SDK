'use strict';
/**
 * openvibe-sdk/cache — shared caching on Valkey, in-process without it (ADR-035; never authoritative).
 *
 *   const cache = createCache({ valkey, namespace: 'pages', ttlSec: 60 });
 *   const page = await cache.getOrSet(`slug:${slug}`, 300, () => db.maybe(sql`…`), { tags: [`space:${id}`] });
 *   await cache.invalidateTag(`space:${id}`);
 *
 * getOrSet protects the database from a stampede twice: one load per key per process (single-flight), and
 * across processes a short lock, so while one process loads, the others wait briefly for its value instead of
 * all querying. Values are JSON. A Valkey error never fails the caller: the loader runs and the error is logged.
 */

function memoryStore(max = 5000) {
    const map = new Map();   // key -> { v, exp }
    const tags = new Map();  // tag -> Set(key)
    const live = (e) => e && (!e.exp || e.exp > Date.now());
    return {
        async get(k) { const e = map.get(k); if (!live(e)) { map.delete(k); return undefined; } map.delete(k); map.set(k, e); return e.v; },
        async set(k, v, ttlSec, tagList) {
            map.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
            if (map.size > max) map.delete(map.keys().next().value);
            for (const t of tagList || []) { if (!tags.has(t)) tags.set(t, new Set()); tags.get(t).add(k); }
        },
        async del(keys) { let n = 0; for (const k of keys) n += map.delete(k) ? 1 : 0; return n; },
        async lock() { return true; },
        async unlock() {},
        async invalidateTag(t) { const ks = tags.get(t); tags.delete(t); return ks ? this.del([...ks]) : 0; },
    };
}

function valkeyStore(valkey, ns) {
    const c = valkey.client;
    const k = (key) => valkey.key('cache', ns, key);
    const tk = (tag) => valkey.key('cache', ns, 'tag', tag);
    return {
        async get(key) { const s = await c.get(k(key)); return s == null ? undefined : JSON.parse(s); },
        async set(key, v, ttlSec, tagList) {
            const m = c.multi().set(k(key), JSON.stringify(v), 'EX', Math.max(1, ttlSec));
            for (const t of tagList || []) m.sadd(tk(t), k(key)).expire(tk(t), Math.max(ttlSec, 86400));
            await m.exec();
        },
        async del(keys) { return keys.length ? c.del(...keys.map(k)) : 0; },
        async lock(key, ms) { return (await c.set(k(`lock:${key}`), '1', 'PX', ms, 'NX')) === 'OK'; },
        async unlock(key) { await c.del(k(`lock:${key}`)); },
        async invalidateTag(t) {
            const members = await c.smembers(tk(t));
            if (members.length) await c.del(...members);   // members are full keys
            await c.del(tk(t));
            return members.length;
        },
    };
}

function createCache({ valkey = null, namespace = 'default', ttlSec = 60, lockMs = 5000, waitMs = 1500, log = console, memoryMax } = {}) {
    const store = valkey ? valkeyStore(valkey, namespace) : memoryStore(memoryMax);
    const inflight = new Map();
    const stats = { hits: 0, misses: 0, loads: 0, errors: 0 };
    const safe = async (fn, fallback) => { try { return await fn(); } catch (err) { stats.errors++; log.warn(`[cache] ${err.message}`); return fallback; } };

    async function getOrSet(key, ttl, loader, { tags } = {}) {
        const hit = await safe(() => store.get(key), undefined);
        if (hit !== undefined) { stats.hits++; return hit; }
        stats.misses++;
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            const locked = await safe(() => store.lock(key, lockMs), true);
            if (!locked) {
                // Another process is loading it: wait briefly for its value.
                const until = Date.now() + waitMs;
                while (Date.now() < until) {
                    await new Promise((r) => setTimeout(r, 50));
                    const v = await safe(() => store.get(key), undefined);
                    if (v !== undefined) { stats.hits++; return v; }
                }
            }
            try {
                stats.loads++;
                const v = await loader();
                if (v !== undefined) await safe(() => store.set(key, v, ttl || ttlSec, tags));
                return v;
            } finally { if (locked) await safe(() => store.unlock(key)); }
        })().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    return {
        get: (key) => safe(() => store.get(key), undefined),
        set: (key, value, ttl, opts = {}) => safe(() => store.set(key, value, ttl || ttlSec, opts.tags)),
        del: (...keys) => safe(() => store.del(keys), 0),
        getOrSet,
        invalidateTag: (tag) => safe(() => store.invalidateTag(tag), 0),
        stats: () => ({ ...stats, store: valkey ? 'valkey' : 'memory' }),
    };
}

module.exports = { createCache };
