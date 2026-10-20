/** openvibe-sdk/reviews: OpenVibe.Reviews — resolve and read entities, and send corrections for the person. */
type Opts = { signal?: AbortSignal };
type ReviewsJson = Record<string, any>;
export type CorrectionTarget = 'entity' | 'alias' | 'signal' | 'summary' | 'aggregate';
export interface Identifiers { name?: string; url?: string; gtin?: string; sku?: string; mpn?: string; source?: unknown; external?: unknown; [k: string]: unknown }
export interface ReviewsClient {
    resolve(identifiers: Identifiers, opts?: Opts): Promise<ReviewsJson>;
    entities: {
        list(opts?: Opts & { q?: string; limit?: number; offset?: number }): Promise<ReviewsJson>;
        get(ref: string, opts?: Opts): Promise<ReviewsJson>;
        history(ref: string, opts?: Opts): Promise<ReviewsJson>;
        aggregate(ref: string, opts?: Opts): Promise<{ aggregate: null | { revision: number; result: ReviewsJson } }>;
        summaryRevision(ref: string, n: number, opts?: Opts): Promise<ReviewsJson>;
    };
    corrections: {
        submit(ref: string, req: { body: string; target_type?: CorrectionTarget; target_id?: string | null; evidence_url?: string | null }, opts?: Opts): Promise<ReviewsJson>;
    };
}
export function createReviewsClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): ReviewsClient;
