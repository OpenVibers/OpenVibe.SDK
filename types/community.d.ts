import type { OpenVibeClient, EntityRef } from './core';

export interface ActingOptions {
    /** usr_… or gst_… (services only). */
    actingSubject?: string;
    origin?: 'ai' | 'user';
    sourceRef?: EntityRef | string;
    staff?: boolean;
}
export type CallOptions = ActingOptions & { signal?: AbortSignal };

export interface CommentQuery { after?: string | number; sort?: 'old' | 'new'; limit?: number; parent?: string | number; }
export interface Comment { id: number; thread_id: number | string; parent_id: number | null; message: string | null; reply_count?: number | null; replies?: Comment[]; [field: string]: unknown; }
export interface CommentPage { thread: Record<string, unknown>; comments: Comment[]; next_cursor: string | null; viewer: Record<string, boolean>; }
export interface CommentsApi {
    resolve(ref: EntityRef, opts?: CallOptions): Promise<{ thread: Record<string, unknown>; created: boolean }>;
    get(id: string, query?: CommentQuery, opts?: CallOptions): Promise<CommentPage>;
    create(id: string, input: { message: string; parent_id?: number | string | null; anon_name?: string }, opts?: CallOptions): Promise<{ comment: Comment }>;
    edit(commentId: number | string, input: { message: string }, opts?: CallOptions): Promise<{ comment: Comment }>;
    delete(commentId: number | string, opts?: CallOptions): Promise<{ ok: true; id: number }>;
    visibility(id: string, visibility: 'public' | 'hidden' | 'locked', opts?: CallOptions): Promise<{ thread: Record<string, unknown> }>;
}

export interface Paste { id: number; slug: string; title?: string; content?: string; language?: string; type?: string; visibility?: string; [field: string]: unknown; }
export interface PasteListQuery { limit?: number; offset?: number; type?: string; search?: string; sort?: string; origin?: string; username?: string; include_unlisted?: boolean; }
export interface CreateTextPaste { title?: string; content: string; language?: string; visibility?: 'public' | 'unlisted' | 'private'; burn_after_read?: boolean; is_nsfw?: boolean; [field: string]: unknown; }
export interface CreateScreenshotPaste { screenshot: Blob | ArrayBuffer | ArrayBufferView; filename?: string; contentType?: string; title?: string; visibility?: 'public' | 'unlisted' | 'private'; [field: string]: unknown; }

export interface PastesApi {
    list(query?: PasteListQuery, opts?: CallOptions): Promise<{ pastes: Paste[]; total: number; limit: number; offset: number; hasMore?: boolean }>;
    iterate(query?: PasteListQuery, opts?: CallOptions): AsyncGenerator<Paste, void, unknown>;
    get(slug: string, opts?: CallOptions & { noView?: boolean }): Promise<{ paste: Paste; liked?: boolean } | null>;
    create(input: CreateTextPaste | CreateScreenshotPaste, opts?: CallOptions): Promise<{ id: number; slug: string; url: string; [field: string]: unknown }>;
    update(slug: string, patch: Partial<CreateTextPaste>, opts?: CallOptions): Promise<{ paste: Paste }>;
    delete(slug: string, opts?: CallOptions): Promise<unknown>;
    fork(slug: string, opts?: CallOptions): Promise<{ id: number; slug: string; url: string; [field: string]: unknown }>;
    like(slug: string, opts?: CallOptions): Promise<{ liked: boolean; likes?: number; [field: string]: unknown }>;
    copy(slug: string, opts?: CallOptions): Promise<{ copies: number }>;
    versions(slug: string, opts?: CallOptions): Promise<{ revision: number; versions: Array<Record<string, unknown>> }>;
    byUser(username: string, query?: { limit?: number; offset?: number }, opts?: CallOptions): Promise<{ pastes: Paste[]; total: number; username: string }>;
    config(opts?: CallOptions): Promise<Record<string, unknown>>;
    comments: {
        list(slug: string, query?: { limit?: number; offset?: number }, opts?: CallOptions): Promise<{ comments: Array<Record<string, unknown>>; total: number }>;
        create(slug: string, input: { content: string; parent_id?: number | null; [field: string]: unknown }, opts?: CallOptions): Promise<{ comment: Record<string, unknown> }>;
        delete(slug: string, commentId: string | number, opts?: CallOptions): Promise<unknown>;
    };
}
export type FeedKind = 'live' | 'stream' | 'clip' | 'video' | 'pic' | 'post' | 'meme' | 'game' | 'update' | 'wiki' | 'quest' | 'chat' | 'event' | 'member';
export interface FeedQuery { kind?: FeedKind; site?: string; q?: string; following?: boolean | 1; cursor?: string; limit?: number; }
export interface FeedItem {
    id: string;
    kind: FeedKind;
    url: string;
    title: string;
    text: string;
    at: string | null;
    site: string;
    site_name: string;
    actor: { name: string | null; avatar: string | null } | null;
    media: { thumb: string; ratio: number; length?: number } | null;
    counts: { views?: number; likes?: number; comments?: number };
    /** True while on air; false on an ended stream. Absent for other kinds. */
    live_now?: boolean;
    label?: 'Trending' | 'AI' | 'System';
}
export interface CreatePostInput {
    text: string;
    pictures?: Array<{ media_id: string; alt: string }>;
}
export interface PostsApi {
    create(input: CreatePostInput, opts?: CallOptions): Promise<{ id: number; post_id: number; text: string; url: string; pictures: Array<{ media_id: string; alt: string | null; url?: string }>; created_at: string }>;
}
export interface CommunityClient {
    pastes: PastesApi;
    comments: CommentsApi;
    feed(query?: FeedQuery, opts?: CallOptions): Promise<{ items: FeedItem[]; next_cursor: string | null }>;
    posts: PostsApi;
    as(who: string | ActingOptions): CommunityClient;
    headers(): Record<string, string>;
}
export declare function createCommunityClient(client: OpenVibeClient, defaults?: ActingOptions & { baseUrl?: string }): CommunityClient;
export declare function actingHeaders(opts?: ActingOptions): Record<string, string>;
