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
export type CommerceCaps = { intent?: string; transfer?: string; subscription?: string; entitlement?: string; rates?: string };
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
    createIntent(a: { provider: string; kind?: 'purchase' | 'subscription'; subject: string; bits?: number; creator?: string; autoRenew?: boolean; successUrl?: string; cancelUrl?: string } & CommerceCall): Promise<any>;
    createTransfer(a: { from: string; to: string; amount: number; kind?: string; target?: unknown; message?: string } & CommerceCall): Promise<any>;
    refundTransfer(a: { txnId: string; amount?: number; reason?: string; key?: string }): Promise<any>;
    subscribeWithCredit(a: { subscriber: string; creator: string; autoRenew?: boolean } & CommerceCall): Promise<any>;
    cancelSubscription(a: { id: string } & CommerceCall): Promise<any>;
    getSubscription(id: string): Promise<any>;
    listSubscriptions(a?: { streamer?: string; subscriber?: string; status?: string }): Promise<any>;
    entitlement(subject: string, creator?: string): Promise<any>;
    rates(): Promise<any>;
    baseUrl(): string;
};
export declare function createCommerceClient(config: CommerceConfig, options: CommerceOptions): CommerceClient;
