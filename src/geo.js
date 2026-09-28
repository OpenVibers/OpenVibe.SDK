'use strict';
/**
 * openvibe-sdk/geo — which OpenVibe node is closest (roadmap WS-X1 task 5, ADR-034 §12). Browser-safe.
 *
 *   const geo = createGeoClient(createClient());
 *   const { node, rtt_ms } = await geo.nearest({ role: 'edge-probe' });   // measured from here
 *   const all = await geo.measure(await geo.nodes({ role: 'ingest' }));  // [{ node, rtt_ms, ok }] fastest first
 *
 * The registry is Network's public GET /api/v1/nodes (network.node-list-result@1). Distance is measured, not
 * guessed: each node's beacon is fetched `samples` times and the best round trip counts (the first fetch also
 * pays for DNS and TLS). Only up or degraded nodes are candidates. When nothing can be measured (offline, every
 * beacon blocked) nearest() falls back to `preferRegion`, then to the first healthy node, and says so
 * (`measured: false`). Location is region-level only: the registry holds no addresses.
 */
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function createGeoClient(client, { baseUrl, fetch: fetchImpl = null, samples = 3, timeoutMs = 3000, now = nowMs } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createGeoClient: pass an openvibe-sdk/core client');
    const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    /** The registry's nodes, optionally for one role or region. */
    async function nodes({ role, region } = {}) {
        const r = await client.json({ service: 'network', baseUrl, path: '/api/v1/nodes', query: { role, region }, auth: false });
        return (r && r.nodes) || [];
    }

    async function rtt(node) {
        let best = null;
        for (let i = 0; i < samples; i++) {
            const t0 = now();
            try {
                const res = await doFetch(`${node.beacon}${node.beacon.includes('?') ? '&' : '?'}t=${Date.now()}-${i}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok && res.status !== 204) continue;
                const ms = now() - t0;
                if (best == null || ms < best) best = ms;
            } catch { /* this sample failed; others may not */ }
        }
        return best == null ? null : Math.round(best * 10) / 10;
    }

    /** Round trips to each node's beacon, measured in parallel: [{ node, rtt_ms, ok }], fastest first. */
    async function measure(list) {
        if (!doFetch) throw new TypeError('createGeoClient: no fetch available to measure with');
        const out = await Promise.all(list.map(async (node) => { const ms = await rtt(node); return { node, rtt_ms: ms, ok: ms != null }; }));
        return out.sort((a, b) => (a.ok === b.ok ? (a.rtt_ms ?? Infinity) - (b.rtt_ms ?? Infinity) : a.ok ? -1 : 1));
    }

    /** The closest healthy node for a role → { node, rtt_ms, measured } or null when the registry has none. */
    async function nearest({ role, region, preferRegion, list } = {}) {
        const candidates = (list || await nodes({ role, region })).filter((n) => n.health && (n.health.status === 'up' || n.health.status === 'degraded'));
        if (!candidates.length) return null;
        const measured = doFetch ? (await measure(candidates)).filter((m) => m.ok) : [];
        if (measured.length) return { node: measured[0].node, rtt_ms: measured[0].rtt_ms, measured: true };
        const pick = (preferRegion && candidates.find((n) => n.location && n.location.region === preferRegion)) || candidates.find((n) => n.health.status === 'up') || candidates[0];
        return { node: pick, rtt_ms: null, measured: false };
    }

    return { nodes, measure, nearest };
}

module.exports = { createGeoClient };
