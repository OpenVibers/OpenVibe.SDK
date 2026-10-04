/** platform.node-capabilities@1: node hardware, placement regions, tags and operating costs. Validated by
 *  openvibe-contracts (required lazily by validateNodeCapabilities). nodeOffers() maps a descriptor to a
 *  platform.resource-offer@1 (kind "node") and a platform.runtime-offer@1. */
export type NodeCpu = { cores: number; threads?: number };
export type NodeGpu = { model: string; count: number; vram_mb?: number };
export type NodeStorage = { capacity_gb: number; available_gb?: number; kind?: string };
export type NodeNetwork = { ingress_mbps: number; egress_mbps: number };
export type NodeCosts = { per_hour_usd: number; egress_per_gb_usd?: number };
export type NodeCapabilities = { node_id: string; cpu: NodeCpu; arch: string; memory_mb: number; gpu?: NodeGpu;
    storage: NodeStorage; network: NodeNetwork; regions: string[]; tags: string[]; costs: NodeCosts;
    capabilities?: string[]; agent_version?: string; updated_at?: string };
export type NodeOffersOptions = { trust?: string };
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function nodeCapabilities(fields: Partial<NodeCapabilities>): NodeCapabilities;
/** Map a Node descriptor to { resource: resource-offer@1, runtime: runtime-offer@1 }. trust defaults to
 *  "first-party"; it is "user-owned" only when opts.trust says so. */
export declare function nodeOffers(descriptor: NodeCapabilities, opts?: NodeOffersOptions): {
    resource: Record<string, unknown>; runtime: Record<string, unknown> };
export declare function validateNodeCapabilities(record: unknown): { ok: boolean; errors: ValidationError[] };
