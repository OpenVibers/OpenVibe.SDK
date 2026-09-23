import type { OpenVibeClient, EntityRef } from './core';

export interface ActingOptions {
    /** usr_… or gst_… (services only). */
    actingSubject?: string;
    origin?: 'ai' | 'user';
    sourceRef?: EntityRef | string;
    staff?: boolean;
}
export type CallOptions = ActingOptions & { signal?: AbortSignal };

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
export interface CommunityClient {
    pastes: PastesApi;
    as(who: string | ActingOptions): CommunityClient;
    headers(): Record<string, string>;
}
export declare function createCommunityClient(client: OpenVibeClient, defaults?: ActingOptions & { baseUrl?: string }): CommunityClient;
export declare function actingHeaders(opts?: ActingOptions): Record<string, string>;
