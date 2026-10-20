/** openvibe-sdk/coupons: OpenVibe.Coupons — stores, their codes, and submitting and reporting codes for the person. */
type Opts = { signal?: AbortSignal };
type CouponsJson = Record<string, any>;
export type ReportOutcome = 'worked' | 'failed';
export type ReportReason = 'invalid' | 'expired' | 'min_spend_not_met' | 'not_eligible' | 'other';
export interface CouponSubmission {
    code: string; title: string; merchant_id?: string; host?: string; url?: string; description?: string | null; expires?: string | null;
    expiry_basis?: 'submitter' | 'evidence'; evidence_url?: string; restrictions?: Record<string, unknown>; hint?: string | null; [k: string]: unknown;
}
export interface CouponsClient {
    merchants: {
        resolve(host: string, opts?: Opts): Promise<CouponsJson>;
        get(id: string, opts?: Opts): Promise<CouponsJson>;
        coupons(id: string, opts?: Opts): Promise<CouponsJson>;
    };
    get(id: string, opts?: Opts): Promise<CouponsJson>;
    submit(fields: CouponSubmission, opts?: Opts): Promise<CouponsJson>;
    report(id: string, req: { outcome: ReportOutcome; reason?: ReportReason | null }, opts?: Opts): Promise<CouponsJson>;
}
export function createCouponsClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): CouponsClient;
