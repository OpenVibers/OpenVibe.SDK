/** The Billing client Tips and VIP share (server only). openvibe-contracts is required lazily, when a token client is created. */
export declare class CommerceError extends Error {
    constructor(message: string, init?: { status?: number | null; code?: string | null; body?: unknown });
    status: number | null;
    code: string | null;
    body: unknown;
    /** No status, 5xx, 429, 401 or code 'billing.frozen'. */
    readonly retryable: boolean;
}
/** `prefix` then each part that is neither null/undefined nor '', joined with ':'; throws TypeError on an empty prefix. */
export declare function intentKey(prefix: string, parts: (string | number | null | undefined)[]): string;
/** { kind, at: now ISO, ...fields } with null/undefined fields stripped; constructed, never posted. */
export declare function receipt(kind: string, fields?: Record<string, unknown>): { kind: string; at: string; [field: string]: unknown };
export type CommerceConfig = {
    billing: { url: string; audience?: string; timeoutMs?: number };
    network?: { internalUrl: string };
    oauth?: { clientId: string; clientSecret: string };
};
export type CommerceCaps = { intent?: string; transfer?: string; subscription?: string; entitlement?: string; rates?: string; tier?: string };
export type CommerceTier = { tier: number; price_cents: number; status: 'active' | 'archived'; updated_at?: string };
export type CommerceTokenClient = { authHeaders(): Promise<Record<string, string>>; invalidate(): void };
export type CommerceOptions = {
    caps: CommerceCaps;
    fetchImpl?: typeof fetch;
    /** Keyed by logical key (intent, transfer, …) or by capability string. */
    tokenClients?: Record<string, CommerceTokenClient> | null;
    timeoutMs?: number;
};
export type CommerceCall = { key?: string; traceparent?: string };
export type CommerceClient = {
    createIntent(a: { provider: string; kind?: 'purchase' | 'subscription'; subject: string; bits?: number; creator?: string; tier?: number; autoRenew?: boolean; successUrl?: string; cancelUrl?: string } & CommerceCall): Promise<any>;
    createTransfer(a: { from: string; to: string; amount: number; kind?: string; target?: unknown; message?: string } & CommerceCall): Promise<any>;
    refundTransfer(a: { txnId: string; amount?: number; reason?: string; key?: string }): Promise<any>;
    subscribeWithCredit(a: { subscriber: string; creator: string; tier?: number; autoRenew?: boolean } & CommerceCall): Promise<any>;
    cancelSubscription(a: { id: string } & CommerceCall): Promise<any>;
    getSubscription(id: string): Promise<any>;
    listSubscriptions(a?: { streamer?: string; subscriber?: string; status?: string }): Promise<any>;
    entitlement(subject: string, creator?: string): Promise<any>;
    rates(): Promise<any>;
    /** A creator's tier prices (Billing, contracts 0.201.0); uses caps.tier, else caps.intent. */
    listTiers(creator: string): Promise<{ streamer: { type: 'user'; id: string }; tiers: CommerceTier[]; default_price_cents: number; min_price_cents: number; max_price_cents: number; max_tiers: number }>;
    /** Set one tier's monthly price (billing.tier.manage). */
    setTier(a: { creator: string; tier: number; priceCents: number; status?: 'active' | 'archived' } & CommerceCall): Promise<{ tier: CommerceTier }>;
    baseUrl(): string;
};
export declare function createCommerceClient(config: CommerceConfig, options: CommerceOptions): CommerceClient;
