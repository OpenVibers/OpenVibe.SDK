import type { OpenVibeClient } from './core';

export interface MediaFile {
    key: string;
    /** The tenant: the app id, a project id (prj_…) or its sandbox tenant (prj_…-sandbox). */
    app_id: string;
    user_id: string | number | null;
    original_name: string;
    size: number;
    mime: string;
    sha256: string;
    /** Media-relative, e.g. /f/<key>; for a sandbox file an absolute signed, expiring URL. */
    url: string;
    /** Absolute public URL, added by the SDK; null for sandbox files (never served publicly). */
    public_url: string | null;
    /** Sandbox files only (Media): the tenant is a developer project's sandbox. */
    sandbox?: true;
    /** Sandbox files only (Media): when `url` stops working. */
    url_expires_at?: string;
    /** Sandbox files only, added by the SDK: the signed `url`. */
    signed_url?: string;
    created_at: string;
    deduplicated?: boolean;
}
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string;

export interface MediaUrls {
    origin: string;
    file(key: string): string;
    vod(id: string | number): string;
    clip(id: string | number): string;
    thumbnail(name: string): string;
    paste(slug: string): string;
    pasteRaw(slug: string): string;
    pasteScreenshot(slug: string): string;
    vodTranscript(id: string | number): string;
    liveTranscript(sel: string | number, opts?: { limit?: number; app?: string }): string;
    liveFrame(sel: string | number, opts?: { width?: number; app?: string; format?: 'json' }): string;
    absolute(path: string): string;
}
export declare function mediaUrls(origin?: string): MediaUrls;

export interface MediaClient {
    app: string;
    urls: MediaUrls;
    files: {
        upload(file: UploadBody, opts?: { filename?: string; contentType?: string; userId?: string | number; actingUserId?: string | number | null; signal?: AbortSignal }): Promise<MediaFile>;
        list(opts?: { limit?: number; offset?: number }): Promise<{ files: MediaFile[]; used_bytes: number; quota_bytes: number; limit: number; offset: number }>;
        iterate(opts?: { pageSize?: number }): AsyncGenerator<MediaFile, void, unknown>;
        get(key: string): Promise<MediaFile | null>;
        delete(key: string, opts?: { actingUserId?: string | number | null }): Promise<boolean>;
    };
    upload: MediaClient['files']['upload'];
}
/**
 * apiKey: the app's Media API key (server only). Without it the client's token is used: a service
 * token, or a developer app token with `app` = its project id (media.object.upload to upload and
 * delete, media.object.read to list and get).
 */
export declare function createMediaClient(client: OpenVibeClient, opts: { app: string; apiKey?: string; actingUserId?: string | number; baseUrl?: string; publicOrigin?: string }): MediaClient;
export declare const DEFAULT_PUBLIC_ORIGIN: string;
