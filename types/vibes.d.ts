/** Vibes Pay for developer apps (server only). Money is whole Vibes; a float is refused. */
export declare class VibesError extends Error {
    constructor(message: string, init?: { status?: number | null; code?: string | null; body?: unknown });
    status: number | null;
    code: string | null;
    body: unknown;
    /** No status, 5xx, 429 or 401. */
    readonly retryable: boolean;
}

export type VibesTokenContext = { service: 'billing'; audience: 'openvibe.billing' };
export type VibesToken = string | Record<string, string>;
export type VibesTokenProvider =
    | ((ctx: VibesTokenContext) => VibesToken | Promise<VibesToken>)
    | {
        getToken?(ctx: VibesTokenContext): VibesToken | Promise<VibesToken>;
        authHeaders?(ctx: VibesTokenContext): VibesToken | Promise<VibesToken>;
        invalidate?(ctx?: VibesTokenContext): void | Promise<void>;
    };

export type VibesOptions = {
    /** The app's token (capability billing.vibes.charge). One of appToken or tokenProvider. */
    appToken?: string;
    /** A function, or an SDK token client (getToken / invalidate), for a token that expires. */
    tokenProvider?: VibesTokenProvider;
    /** Billing's origin, e.g. https://billing.openvibe.network. */
    billingUrl: string;
    fetchImpl?: typeof fetch;
    /** Per request, default 10000. */
    timeoutMs?: number;
};

export type VibesChargeCreate = {
    /** A positive whole number of Vibes. */
    amount: number;
    description: string;
    /** The app's order id; also the idempotency key, so a retry never charges twice. */
    reference: string;
    /** Where the pay sheet sends the person afterwards (http or https). */
    return_url?: string;
};

export type VibesCharge = {
    id: string;
    pay_url: string;
    status: 'pending' | 'paid' | 'refunded' | 'cancelled' | 'expired' | string;
    expires_at?: string;
    amount?: number;
    description?: string;
    reference?: string;
    [field: string]: unknown;
};

export type VibesClient = {
    charges: {
        create(input: VibesChargeCreate): Promise<VibesCharge>;
        get(chargeId: string): Promise<VibesCharge>;
        refund(chargeId: string, opts?: { reason?: string }): Promise<VibesCharge>;
    };
    webhooks: {
        /** Constant-time check of the RAW body against X-OpenVibe-Signature-V2 (or a legacy sha256= header). */
        verify(rawBody: string | Uint8Array | ArrayBufferView, signatureHeader: string, secret: string, opts?: { toleranceSec?: number; now?: number }): boolean;
    };
    baseUrl(): string;
};

export declare function createVibesClient(options: VibesOptions): VibesClient;
/** The same check as vibes.webhooks.verify, for a receiver that only verifies webhooks. */
export declare function verifyWebhook(rawBody: string | Uint8Array | ArrayBufferView, signatureHeader: string, secret: string, opts?: { toleranceSec?: number; now?: number }): boolean;
export declare const SIGNATURE_TOLERANCE_SEC: number;
