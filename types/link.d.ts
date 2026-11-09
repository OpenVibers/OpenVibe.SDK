/** platform.link-capabilities@1: Link machine hardware, placement regions, tags and operating costs. Validated by
 *  openvibe-contracts (required lazily by validateLinkCapabilities). linkOffers() maps a descriptor to a
 *  platform.resource-offer@1 (kind "node") and a platform.runtime-offer@1. */
export type LinkCpu = { cores: number; threads?: number };
export type LinkGpu = { model: string; count: number; vram_mb?: number };
export type LinkStorage = { capacity_gb: number; available_gb?: number; kind?: string };
export type LinkNetwork = { ingress_mbps: number; egress_mbps: number };
export type LinkCosts = { per_hour_usd: number; egress_per_gb_usd?: number };
export type LinkCapabilities = { node_id: string; cpu: LinkCpu; arch: string; memory_mb: number; gpu?: LinkGpu;
    storage: LinkStorage; network: LinkNetwork; regions: string[]; tags: string[]; costs: LinkCosts;
    capabilities?: string[]; agent_version?: string; updated_at?: string };
export type LinkOffersOptions = { trust?: string };
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function linkCapabilities(fields: Partial<LinkCapabilities>): LinkCapabilities;
/** Map a Link descriptor to { resource: resource-offer@1, runtime: runtime-offer@1 }. trust defaults to
 *  "first-party"; it is "user-owned" only when opts.trust says so. */
export declare function linkOffers(descriptor: LinkCapabilities, opts?: LinkOffersOptions): {
    resource: Record<string, unknown>; runtime: Record<string, unknown> };
export declare function validateLinkCapabilities(record: unknown): { ok: boolean; errors: ValidationError[] };
export declare function createLink(options: import('./machines').MachinesClientOptions): { compute: import('./machines').LinkComputeClient };
