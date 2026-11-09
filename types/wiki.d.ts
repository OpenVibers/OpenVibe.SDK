/** openvibe-sdk/wiki: OpenVibe.Wiki's reads, article writes, picture suggestions and the wiki writer. */
type Opts = { signal?: AbortSignal };
type WikiJson = Record<string, any>;
type BlockTree = { type: 'root'; children?: unknown[]; [key: string]: unknown };
export interface WikiImagesSuggestFields {
    query?: string | null;
    section?: string | null;
    count?: number;
    allow_ai?: boolean;
    choice?: { model: string; source: 'openvibe' | 'keys' | 'machines'; machine?: string };
}
export interface WikiArticleDraftFields {
    instruction?: string | null;
    choice?: { model: string; source: 'openvibe' | 'keys' | 'machines'; machine?: string };
}
export interface WikiClient {
    search(q: string, opts?: Opts & { space?: string; limit?: number }): Promise<{ results: WikiJson[] }>;
    spaces: { list(opts?: Opts): Promise<WikiJson>; get(space: string, opts?: Opts): Promise<WikiJson> };
    pages: {
        get(id: string, opts?: Opts & { revision?: number }): Promise<WikiJson>;
        revisions(id: string, opts?: Opts & { before?: number; limit?: number }): Promise<WikiJson>;
        revision(id: string, n: number, opts?: Opts): Promise<WikiJson>;
        diff(id: string, opts: Opts & { from: number; to: number; mode?: string }): Promise<WikiJson>;
        citations(id: string, n: number, opts?: Opts): Promise<WikiJson>;
        blocks(id: string, opts?: Opts & { revision?: number }): Promise<WikiJson>;
    };
    articles: {
        create(space: string, fields: { title: string; body?: string; blocks?: BlockTree; summary?: string | null; parent_id?: string | null; visibility?: 'public' | 'members' | 'vip' | 'private' }, opts?: Opts): Promise<WikiJson>;
        update(id: string, fields: { expected_revision?: number; title?: string; body?: string; blocks?: BlockTree; summary?: string | null; message?: string | null }, opts?: Opts): Promise<WikiJson>;
        draft(id: string, fields?: WikiArticleDraftFields, opts?: Opts): Promise<WikiJson>;
    };
    images: {
        suggest(id: string, fields?: WikiImagesSuggestFields, opts?: Opts): Promise<WikiJson>;
    };
}
export function createWikiClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): WikiClient;
