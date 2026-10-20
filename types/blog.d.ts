/** openvibe-sdk/blog: OpenVibe.Blog — a blog's posts and feed, and writing posts for the person who authorized the app. */
type Opts = { signal?: AbortSignal };
type BlogJson = Record<string, any>;
export type PostVisibility = 'public' | 'unlisted' | 'members' | 'private';
export interface PostFields {
    title?: string; body?: string; summary?: string | null; visibility?: PostVisibility; slug?: string; entitlement_key?: string;
    allow_comments?: boolean; noindex?: boolean; series_id?: string | null; series_position?: number | null;
    citations?: unknown[]; message?: string | null; expected_revision?: number; [k: string]: unknown;
}
export interface BlogClient {
    blogs: {
        get(handle: string, opts?: Opts): Promise<BlogJson>;
        posts(handle: string, opts?: Opts & { limit?: number; offset?: number; all?: boolean }): Promise<{ total?: number; posts: BlogJson[] }>;
        feed(handle: string, opts?: Opts): Promise<BlogJson>;
    };
    posts: {
        create(handle: string, fields: PostFields & { title: string }, opts?: Opts): Promise<{ post: BlogJson; revision: number }>;
        get(id: string, opts?: Opts): Promise<{ post: BlogJson }>;
        update(id: string, fields: PostFields, opts?: Opts): Promise<{ post: BlogJson; revision: number; created: boolean }>;
        publish(id: string, req?: { revision?: number }, opts?: Opts): Promise<{ post: BlogJson; changed: boolean }>;
        unpublish(id: string, opts?: Opts): Promise<{ post: BlogJson; changed: boolean }>;
        schedule(id: string, req: { at: string; revision?: number; action?: 'publish' | 'unpublish' }, opts?: Opts): Promise<{ job: BlogJson; created: boolean; post: BlogJson }>;
        cancelSchedule(id: string, opts?: Opts): Promise<{ cancelled: boolean; post: BlogJson }>;
        revert(id: string, req: { to_revision: number; expected_revision?: number }, opts?: Opts): Promise<{ revision: number; post: BlogJson }>;
        remove(id: string, opts?: Opts): Promise<{ deleted: boolean; id: string }>;
        revisions(id: string, opts?: Opts): Promise<BlogJson>;
        revision(id: string, n: number, opts?: Opts): Promise<BlogJson>;
    };
}
export function createBlogClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): BlogClient;
