/** openvibe-sdk/wiki: OpenVibe.Wiki's reads — search, spaces, pages, revisions, diffs and citations. */
type Opts = { signal?: AbortSignal };
type WikiJson = Record<string, any>;
export interface WikiClient {
    search(q: string, opts?: Opts & { space?: string; limit?: number }): Promise<{ results: WikiJson[] }>;
    spaces: { list(opts?: Opts): Promise<WikiJson>; get(space: string, opts?: Opts): Promise<WikiJson> };
    pages: {
        get(id: string, opts?: Opts & { revision?: number }): Promise<WikiJson>;
        revisions(id: string, opts?: Opts & { before?: number; limit?: number }): Promise<WikiJson>;
        revision(id: string, n: number, opts?: Opts): Promise<WikiJson>;
        diff(id: string, opts: Opts & { from: number; to: number; mode?: string }): Promise<WikiJson>;
        citations(id: string, n: number, opts?: Opts): Promise<WikiJson>;
    };
}
export function createWikiClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): WikiClient;
