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
export interface SearchClient {
    query(text: string, opts?: SearchOptions): Promise<SearchPage>;
    iterate(text: string, opts?: SearchOptions & { max?: number }): AsyncGenerator<SearchDocument, void, unknown>;
    suggest(text: string, opts?: Pick<SearchOptions, 'owner' | 'type' | 'limit' | 'actingSubject' | 'signal'>): Promise<{ suggestions: Array<{ owner: string; type: string; id: string; title: string; canonical_url?: string }> }>;
    document(owner: string, type: string, id: string, opts?: Pick<SearchOptions, 'actingSubject' | 'signal'>): Promise<SearchDocument | null>;
}
export function createSearchClient(client: OpenVibeClient, defaults?: { baseUrl?: string; actingSubject?: string }): SearchClient;
export function queryOf(text: string, opts?: SearchOptions): Record<string, string | string[] | number>;
