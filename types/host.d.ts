/** openvibe-sdk/host: OpenVibe.Host's public hosting catalog (sent without a token). */
type Opts = { signal?: AbortSignal };
type HostJson = Record<string, any>;
export interface PlanFilters { kind?: string; min_vcpu?: number; min_ram_mb?: number; min_disk_gb?: number; max_price?: number; currency?: string; location?: string; provider?: string; sort?: 'price' | 'price_per_vcpu' | 'price_per_gb_ram' | 'price_per_gb_disk' | 'checked_at'; cursor?: string }
export interface OfferFilters { sort?: string; currency?: string; max_monthly?: number; source?: string; priced?: boolean | number; cursor?: string }
export interface HostClient {
    providers: { list(opts?: Opts): Promise<{ providers: HostJson[] }>; get(slug: string, opts?: Opts): Promise<{ provider: HostJson }> };
    plans: { list(filters?: PlanFilters & Opts): Promise<{ plans: HostJson[]; next_cursor: string | null }>; get(id: string, opts?: Opts): Promise<{ plan: HostJson }> };
    promos: { list(opts?: Opts): Promise<{ promos: HostJson[] }> };
    offers: { list(filters?: OfferFilters & Opts): Promise<{ offers: HostJson[]; next_cursor: string | null }> };
    domains: {
        list(filters?: Record<string, unknown> & Opts): Promise<HostJson>;
        tld(tld: string, opts?: Opts): Promise<{ tld: HostJson }>;
        check(name: string, opts?: Opts): Promise<{ check: HostJson }>;
    };
    benchmarks: { list(filters?: Record<string, unknown> & Opts): Promise<HostJson>; get(id: string, opts?: Opts): Promise<{ benchmark: HostJson }> };
}
export function createHostClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): HostClient;
