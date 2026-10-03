'use strict';
/**
 * openvibe-sdk/node — platform.node-capabilities@1, plus nodeOffers() that maps a Node descriptor to a
 * platform.resource-offer@1 (kind "node") and a platform.runtime-offer@1.
 * Pure construction and validation, no I/O and no dependency at require time.
 *
 *   const { nodeCapabilities, nodeOffers, validateNodeCapabilities } = require('openvibe-sdk/node');
 *   const caps = nodeCapabilities({ node_id, cpu, arch, memory_mb, storage, network, regions, tags, costs });
 *   const { resource, runtime } = nodeOffers(caps);
 */

/** The fields platform.node-capabilities@1 requires or allows; null/undefined are stripped. */
function nodeCapabilities(fields) {
    const f = fields || {};
    const record = {
        node_id: f.node_id,
        cpu: f.cpu,
        arch: f.arch,
        memory_mb: f.memory_mb,
        gpu: f.gpu,
        storage: f.storage,
        network: f.network,
        regions: f.regions,
        tags: f.tags,
        costs: f.costs,
        capabilities: f.capabilities,
        agent_version: f.agent_version,
        updated_at: f.updated_at,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/**
 * Map a Node descriptor (platform.node-capabilities@1) to two offers:
 *  - resource: a platform.resource-offer@1 with kind "node", capabilities including every advertised
 *    worker capability prefixed "worker:<name>", trust from opts.trust or "first-party";
 *  - runtime: a platform.runtime-offer@1 with kind "container" (the default runtime a node offers),
 *    limits from cpu/memory, price from costs.per_hour_usd.
 * opts.trust defaults to "first-party"; it is "user-owned" only when opts.trust says so.
 */
function nodeOffers(descriptor, opts = {}) {
    const d = descriptor || {};
    const trust = opts.trust || 'first-party';
    const caps = Array.isArray(d.capabilities) ? d.capabilities.slice() : [];
    // Add worker:<name> for each worker capability already in the form "worker:<name>"
    // (the descriptor's capabilities field uses the same form as resource-offer).
    const region = Array.isArray(d.regions) && d.regions.length ? d.regions[0] : 'global';
    const now = new Date().toISOString();

    const resource = {
        offer_id: `node:${d.node_id || 'unknown'}`,
        kind: 'node',
        node_id: d.node_id,
        region,
        trust,
        capabilities: caps,
        capacity: {
            cpu: d.cpu ? { available_cores: d.cpu.cores, utilization: 0 } : undefined,
            memory: d.memory_mb != null ? { available_mb: d.memory_mb } : undefined,
            gpu: d.gpu ? { type: d.gpu.model, vram_free_mb: d.gpu.vram_mb } : undefined,
            disk: d.storage ? { scratch_gb: d.storage.available_gb != null ? d.storage.available_gb : d.storage.capacity_gb } : undefined,
        },
        health: { status: 'up', checked_at: now },
        pricing: d.costs ? { model: 'per-second', marginal_usd_per_unit: (Number(d.costs.per_hour_usd) || 0) / 3600 } : { model: 'prepaid' },
        updated_at: d.updated_at || now,
    };
    // Strip undefined keys from capacity
    if (resource.capacity) {
        for (const k of Object.keys(resource.capacity)) if (resource.capacity[k] == null) delete resource.capacity[k];
    }

    const cpuCores = d.cpu ? Number(d.cpu.cores) || 1 : 1;
    const memoryMb = Number(d.memory_mb) || 512;
    const runtime = {
        id: `runtime:node:${d.node_id || 'unknown'}`,
        kind: 'container',
        region,
        node: d.node_id,
        limits: { cpu_cores: cpuCores, memory_mb: memoryMb },
        price: { amount_usd: d.costs ? (Number(d.costs.per_hour_usd) || 0) : 0, unit: 'hour' },
        availability: 'available',
        constraints: [trust],
    };

    return { resource, runtime };
}

/** { ok, errors } for a record against platform.node-capabilities@1. */
function validateNodeCapabilities(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.node-capabilities@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { nodeCapabilities, nodeOffers, validateNodeCapabilities };
