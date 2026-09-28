'use strict';
/**
 * openvibe-sdk/pubsub — fan-out between a service's processes and hosts on Valkey (ADR-035), in-process without
 * Valkey. For realtime delivery (chat rooms, live counters, cache invalidation), never for durable work: a
 * message published while nobody listens is gone (use openvibe-sdk/queue or OpenVibe.Events for that).
 *
 *   const ps = createPubSub({ valkey });
 *   const off = await ps.subscribe('room:42', (msg) => broadcast(msg));
 *   await ps.publish('room:42', { text: 'hi' });
 *
 * Channels live inside the service's prefix (its Valkey user may use no others). Messages are JSON.
 */
const { EventEmitter } = require('events');

function createPubSub({ valkey = null, log = console } = {}) {
    if (!valkey) {
        const ee = new EventEmitter(); ee.setMaxListeners(0);
        return {
            async publish(channel, msg) { const n = ee.listenerCount(channel); ee.emit(channel, JSON.parse(JSON.stringify(msg))); return n; },
            async subscribe(channel, fn) { ee.on(channel, fn); return async () => { ee.off(channel, fn); }; },
            async close() { ee.removeAllListeners(); },
        };
    }
    const handlers = new Map();   // full channel -> Set(fn)
    let sub = null;
    const full = (ch) => valkey.key('ps', ch);
    function subscriber() {
        if (sub) return sub;
        sub = valkey.duplicate();
        sub.on('message', (ch, raw) => {
            const set = handlers.get(ch);
            if (!set) return;
            let msg; try { msg = JSON.parse(raw); } catch { return; }
            for (const fn of set) { try { fn(msg); } catch (err) { log.warn(`[pubsub] handler on ${ch}: ${err.message}`); } }
        });
        return sub;
    }
    return {
        publish: (channel, msg) => valkey.client.publish(full(channel), JSON.stringify(msg)),
        async subscribe(channel, fn) {
            const ch = full(channel);
            if (!handlers.has(ch)) { handlers.set(ch, new Set()); await subscriber().subscribe(ch); }
            handlers.get(ch).add(fn);
            return async () => {
                const set = handlers.get(ch);
                if (!set) return;
                set.delete(fn);
                if (!set.size) { handlers.delete(ch); await subscriber().unsubscribe(ch).catch(() => {}); }
            };
        },
        async close() { handlers.clear(); if (sub) { try { await sub.quit(); } catch { sub.disconnect(); } sub = null; } },
    };
}

module.exports = { createPubSub };
