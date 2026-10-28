import type { OpenVibeClient } from './core';

export interface SearchDocument {
    owner: string; type: string; id: string; revision?: number; visibility?: string;
    title?: string; summary?: string; canonical_url?: string; language?: string | null;
    facets?: Record<string, string | number | boolean | string[]>;
    authorship?: 'human' | 'ai_assisted' | 'ai_generated' | 'imported';
    published_at?: string | null; updated_at?: string | null; indexable?: boolean;
    /** Search's escaped snippet with <mark> around matches. */
    snippet_html?: string | null;
    [field: string]: unknown;
}
export interface SearchOptions {
    owner?: string; type?: string; lang?: string; limit?: number; cursor?: string | null;
    /** facet.<key>=<value> filters. */
    filter?: Record<string, string | number | boolean | Array<string | number> | null | undefined>;
    /** Facet keys to count over what the caller can see. */
    facets?: string[] | string;
    /** usr_… or gst_…; services holding search.query.delegate only. */
    actingSubject?: string;
    signal?: AbortSignal;
}
export interface SearchPage { results: SearchDocument[]; next_cursor: string | null; facets?: Record<string, Array<{ value: string; count: number }>>; }
export type FabricScope = 'network' | 'mine' | 'web' | 'news' | 'images' | 'video' | 'products' | 'people' | 'places' | 'code';
export interface FabricOptions {
    scopes?: FabricScope[] | string;
    freshness?: 'any' | 'day' | 'week' | 'month' | 'year';
    depth?: 'quick' | 'standard' | 'deep';
    answer?: boolean;
    limit?: number; cursor?: string | null;
    owner?: string; type?: string; lang?: string;
    /** web: results from this host only. */
    site?: string;
    actingSubject?: string;
    signal?: AbortSignal;
}
export interface FabricResult {
    scope: FabricScope; kind: 'document' | 'page'; title: string; url: string;
    snippet?: string | null; site?: string | null; image?: string | null;
    published_at?: string | null; retrieved_at?: string | null;
    /** page: who found it (open_index, deepseek, wikipedia, …). */
    provider?: string | null;
    owner?: string | null; type?: string | null; id?: string | null; score?: number | null;
}
export interface FabricExplainStep { scope: FabricScope; step: string; ok: boolean; count?: number; ms?: number; cached?: boolean; cost_usd?: number; skipped?: string | null; }
/** search.fabric-result@1 */
export interface FabricAnswer {
    results: FabricResult[];
    groups: Partial<Record<FabricScope, number>>;
    answer?: { text: string; citations: number[]; label: 'Written by AI from these sources' } | null;
    citations?: Array<{ n: number; url: string; title: string; provider?: string | null; retrieved_at?: string | null }>;
    route: { explain: FabricExplainStep[]; cost_usd: number };
    next_cursor: string | null;
}
/** search.provider-offer@1 */
export interface ProviderOffer {
    provider: string; name?: string; scopes: FabricScope[]; price_usd_per_call: number; independent_index?: boolean;
    available: boolean; reason?: string | null; daily_cap?: number | null; used_today?: number | null;
    latency_ms_p50?: number | null; answered_rate?: number | null; terms_url?: string | null; checked_at: string;
}
export interface SearchClient {
    query(text: string, opts?: SearchOptions): Promise<SearchPage>;
    /** With scopes: the Search Fabric. */
    query(text: string, opts: FabricOptions & { scopes: FabricScope[] | string }): Promise<FabricAnswer>;
    fabric(text: string, opts?: FabricOptions): Promise<FabricAnswer>;
    providers(opts?: Pick<FabricOptions, 'signal'>): Promise<{ providers: ProviderOffer[] }>;
    iterate(text: string, opts?: SearchOptions & { max?: number }): AsyncGenerator<SearchDocument, void, unknown>;
    suggest(text: string, opts?: Pick<SearchOptions, 'owner' | 'type' | 'limit' | 'actingSubject' | 'signal'>): Promise<{ suggestions: Array<{ owner: string; type: string; id: string; title: string; canonical_url?: string }> }>;
    document(owner: string, type: string, id: string, opts?: Pick<SearchOptions, 'actingSubject' | 'signal'>): Promise<SearchDocument | null>;
}
export function createSearchClient(client: OpenVibeClient, defaults?: { baseUrl?: string; actingSubject?: string }): SearchClient;
export function queryOf(text: string, opts?: SearchOptions): Record<string, string | string[] | number>;
export function fabricOf(text: string, opts?: FabricOptions): Record<string, string | number>;
