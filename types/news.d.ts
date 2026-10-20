/** openvibe-sdk/news: OpenVibe.News' published stories (sent without a token). */
type Opts = { signal?: AbortSignal };
type NewsJson = Record<string, any>;
export interface NewsClient {
    topics(opts?: Opts): Promise<{ topics: NewsJson[] }>;
    stories: {
        list(opts?: Opts & { topic?: string; limit?: number; offset?: number }): Promise<{ total: number; stories: NewsJson[] }>;
        get(id: string, opts?: Opts): Promise<{ story: NewsJson }>;
    };
}
export function createNewsClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): NewsClient;
