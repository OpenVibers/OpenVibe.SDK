'use strict';
/**
 * openvibe-sdk/valkey — the shared connection to Valkey (ADR-035): the service's user is confined to its key
 * prefix (VALKEY_PREFIX, e.g. "ov:wiki:"), so every key and channel this SDK touches goes through key().
 * Valkey is never authoritative (ADR-007 2026-09-24 rule 4): caches, limits, queues and fan-out only.
 *
 *   const { createValkey } = require('openvibe-sdk/valkey');
 *   const valkey = createValkey();                 // VALKEY_URL + VALKEY_PREFIX, or { url, prefix }
 *   await valkey.client.set(valkey.key('x'), '1', 'EX', 60);
 *
 * Commands are auto-pipelined (many callers in one tick share one round trip). A blocking consumer (queues) or a
 * subscriber gets its own connection through duplicate(). Without a URL, createValkey returns null, and the
 * cache, limits, queue and pubsub modules fall back to their in-process implementations.
 */

function createValkey({ url = process.env.VALKEY_URL, prefix = process.env.VALKEY_PREFIX || '', lazyConnect = false, log = console, client = null } = {}) {
    if (!url && !client) return null;
    let Valkey;
    if (!client) {
        try { Valkey = require('iovalkey'); } catch { throw new Error('openvibe-sdk/valkey: install `iovalkey` in the service (npm i iovalkey)'); }
    }
    // enableReadyCheck off: a service's ACL user has no INFO (the check logged NOPERM on every connect); ready() pings.
    const opts = { maxRetriesPerRequest: 3, enableAutoPipelining: true, connectTimeout: 5000, lazyConnect, enableReadyCheck: false };
    const c = client || new Valkey(url, opts);
    let lastError = null;
    c.on('error', (err) => { if (!lastError || lastError.message !== err.message) log.warn(`[valkey] ${err.message}`); lastError = err; });
    c.on('ready', () => { lastError = null; });
    const dupes = new Set();
    return {
        client: c,
        prefix,
        /** The full key (or channel) for a name inside this service's prefix. */
        key: (...parts) => prefix + parts.join(':'),
        /** A second connection with the same settings (for BLOCK reads and subscriptions). */
        duplicate() { const d = c.duplicate({ enableAutoPipelining: false }); d.on('error', () => {}); dupes.add(d); return d; },
        /** Readiness: a real PING within 1 s. */
        async ready() {
            try {
                const pong = await Promise.race([c.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))]);
                return pong === 'PONG' ? { ok: true, detail: { store: 'valkey' } } : { ok: false, error: `unexpected ${pong}` };
            } catch (err) { return { ok: false, error: `valkey: ${err.message}` }; }
        },
        async close() { for (const d of dupes) { try { await d.quit(); } catch { d.disconnect(); } } try { await c.quit(); } catch { c.disconnect(); } },
    };
}

module.exports = { createValkey };
