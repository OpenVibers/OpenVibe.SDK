/** openvibe-sdk/vip: the consumer seam for products that honour OpenVibe.VIP memberships (server-side). */
export interface VipTokenClient { authHeaders(): Promise<Record<string, string>>; invalidate?(): void }
export interface VipClientOptions {
    baseUrl?: string;
    tokenClient?: VipTokenClient | null;
    getToken?: (() => Promise<string>) | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
    log?: { warn(...a: unknown[]): void } | null;
}
export interface VipRef { service: string; type: string; id: string }
export interface VipDecision { allow: boolean; reason: string; [k: string]: unknown }
export interface VipEntitlement { status: 'active' | 'inactive' | 'unknown' | string; active: boolean; product_perks?: unknown[]; [k: string]: unknown }
export interface VipClient {
    evaluate(input: { subject?: string | null; resource: VipRef; owner?: string | null; ruleId?: string; mode?: 'projection' | 'authoritative'; fallback?: { requirement: string; binding?: string } }): Promise<VipDecision>;
    checkEntitlement(input: { subject: string; creator: string; mode?: 'projection' | 'authoritative'; product?: string }): Promise<VipEntitlement>;
    isMember(subject: string, creator: string, opts?: { mode?: 'projection' | 'authoritative' }): Promise<boolean>;
    [k: string]: unknown;
}
export interface VipCache {
    entitlement(input: { subject: string; creator: string; product?: string }): Promise<VipEntitlement>;
    peekEntitlement(input: { subject: string; creator: string; product?: string }): VipEntitlement | undefined;
    evaluate(input: { subject?: string | null; resource: VipRef; owner?: string | null; fallback?: { requirement: string; binding?: string }; mode?: string }): Promise<VipDecision>;
    invalidate(input: { member: string; creator: string }): void;
    handleEvent(envelope: unknown): boolean;
    clear(): void;
    readonly bounds: Record<string, number>;
}
export function createVipClient(options?: VipClientOptions): VipClient;
export function createVipCache(options: { vip: VipClient; ttlMs?: number; denyTtlMs?: number; unavailableTtlMs?: number; maxEntries?: number; now?: () => number }): VipCache;
