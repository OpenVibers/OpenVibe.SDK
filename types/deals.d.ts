/** openvibe-sdk/deals: OpenVibe.Deals — offers, products and stores, and posting, voting, flagging and watches for the person. */
type Opts = { signal?: AbortSignal };
type DealsJson = Record<string, any>;
export type FlagKind = 'expired' | 'price_wrong' | 'spam' | 'duplicate' | 'other';
export type WatchKind = 'keyword' | 'product' | 'price_below' | 'search';
export interface Observation { price?: string | number | null; currency?: string | null; shipping?: string | number | null; shipping_note?: string | null; condition?: string | null; availability?: string | null; [k: string]: unknown }
export interface DealsClient {
    offers: {
        list(opts?: Opts & { sort?: 'hot' | 'new'; page?: number }): Promise<DealsJson>;
        get(id: string, opts?: Opts): Promise<DealsJson>;
        hotness(id: string, opts?: Opts): Promise<DealsJson>;
        submit(fields: Observation & { url: string; title: string; description?: string | null; category?: string | null; expires_at?: string | null; store_name?: string | null; product_slug?: string | null }, opts?: Opts): Promise<DealsJson>;
        update(id: string, patch: { title?: string; description?: string | null; category?: string | null; expires_at?: string | null; product?: unknown }, opts?: Opts): Promise<DealsJson>;
        observe(id: string, observation: Observation, opts?: Opts): Promise<DealsJson>;
        vote(id: string, value: 1 | -1, opts?: Opts): Promise<DealsJson>;
        unvote(id: string, opts?: Opts): Promise<DealsJson>;
        flag(id: string, req: { kind: FlagKind; reason?: string | null; duplicate_of?: string | null }, opts?: Opts): Promise<DealsJson>;
    };
    products: { get(slug: string, opts?: Opts): Promise<DealsJson> };
    stores: { get(domain: string, opts?: Opts): Promise<DealsJson> };
    watches: {
        list(opts?: Opts): Promise<DealsJson>;
        create(fields: { kind: WatchKind; query?: string | null; product?: string | null; max_price?: string | number | null; currency?: string | null; label?: string | null }, opts?: Opts): Promise<DealsJson>;
        remove(id: string, opts?: Opts): Promise<DealsJson>;
    };
}
export function createDealsClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): DealsClient;
