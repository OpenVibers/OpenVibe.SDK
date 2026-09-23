import type { OpenVibeClient } from './core';

export interface MediaFile {
    key: string;
    app_id: string;
    user_id: string | number | null;
    original_name: string;
    size: number;
    mime: string;
    sha256: string;
    /** Media-relative, e.g. /f/<key> */
    url: string;
    /** Absolute, added by the SDK. */
    public_url: string;
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
/** apiKey: the app's Media API key (server only). Without it the client's token (a service token with media.object.upload) is used. */
export declare function createMediaClient(client: OpenVibeClient, opts: { app: string; apiKey?: string; actingUserId?: string | number; baseUrl?: string; publicOrigin?: string }): MediaClient;
export declare const DEFAULT_PUBLIC_ORIGIN: string;
