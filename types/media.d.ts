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

/** A Media object (object API v2, `/api/v2/:app/objects`): Media's public shape. */
export interface MediaObject {
    id: string;
    media_ref?: { media_id: string };
    legacy_ref?: string | null;
    app_id: string;
    namespace?: string;
    kind: 'vod' | 'clip' | 'file' | 'thumbnail' | 'screenshot' | 'avatar' | 'asset' | string;
    owner?: { subject: string | null; app: string | null; user_id: number | null };
    visibility: 'public' | 'unlisted' | 'private';
    lifecycle_status: 'uploading' | 'ready' | 'failed' | 'archived' | 'deleted' | string;
    mime_type: string | null;
    size_bytes: number;
    content_hash: string | null;
    metadata?: Record<string, unknown>;
    held?: boolean;
    /** Public/unlisted and ready: the public URL; null otherwise (private, sandbox). */
    public_url?: string | null;
    sandbox?: true;
    locations?: Array<{ provider: 'local' | 'b2' | 'r2'; storage_class: string | null; state: string; size_bytes: number | null; verified_at: string | null; canonical: boolean }>;
    created_at?: string;
    updated_at?: string;
    deleted_at?: string | null;
    [key: string]: unknown;
}

/** A Media job (`/api/v2/:app/jobs`). */
export interface MediaJob {
    id: string;
    app_id: string;
    object_id: string | null;
    type: 'thumbnail.regenerate' | 'invariant.scan' | 'object.split' | 'object.remux' | string;
    status: 'proposed' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    params: Record<string, unknown>;
    result: unknown;
    error: string | null;
    error_code: string | null;
    attempts: number;
    max_attempts: number;
    cancel_requested: boolean;
    idempotency_key: string | null;
    created_at: string;
    finished_at: string | null;
    [key: string]: unknown;
}

export interface ObjectUploadOptions {
    kind?: MediaObject['kind'];
    visibility?: MediaObject['visibility'];
    mimeType?: string;
    contentType?: string;
    filename?: string;
    metadata?: Record<string, unknown>;
    /** Expected sha256 (hex) for Media to verify; computed when omitted and the data is at most hashMaxBytes; false: none. */
    contentHash?: string | false;
    userId?: number;
    subject?: string | null;
    actingUserId?: string | number | null;
    /** 'auto' (default): multipart above multipartThreshold, or when Media refuses one part. */
    multipart?: 'auto' | boolean;
    partSize?: number;
    uploadTtl?: number;
    signal?: AbortSignal;
    onProgress?(p: { uploadedBytes: number; totalBytes: number; part?: number }): void;
}

/** err.resume of an sdk.upload_incomplete error. */
export interface ObjectUploadRef { objectId: string; uploadId: string; missing?: number[] }

export interface ObjectsClient {
    app: string;
    /** Media's origin: the baseUrl option, or the platform descriptor's live origin for `media`. */
    baseUrl(): Promise<string>;
    upload(data: UploadBody, opts?: ObjectUploadOptions): Promise<MediaObject>;
    resume(ref: ObjectUploadRef, data: UploadBody, opts?: { signal?: AbortSignal; onProgress?: ObjectUploadOptions['onProgress']; contentHash?: string | false }): Promise<MediaObject>;
    get(id: string): Promise<MediaObject | null>;
    signedUrl(id: string, opts?: { ttl?: number }): Promise<{ url: string; expires_at: string | null; public: boolean }>;
    delete(id: string): Promise<boolean>;
    list(opts?: { kind?: string; visibility?: string; status?: string; owner?: string; userId?: number; limit?: number; cursor?: string; includeDeleted?: boolean }): Promise<{ objects: MediaObject[]; next_cursor: string | null; limit: number }>;
    iterate(opts?: { kind?: string; visibility?: string; status?: string; owner?: string; userId?: number; limit?: number; includeDeleted?: boolean }): AsyncGenerator<MediaObject, void, unknown>;
    jobs: {
        create(opts: { type: MediaJob['type']; objectId?: string; params?: Record<string, unknown>; idempotencyKey?: string; maxAttempts?: number }): Promise<MediaJob>;
        get(id: string): Promise<MediaJob | null>;
        list(opts?: { status?: MediaJob['status']; type?: string; objectId?: string; limit?: number; cursor?: string }): Promise<{ jobs: MediaJob[]; next_cursor: string | null; limit: number }>;
        approve(id: string): Promise<MediaJob>;
        cancel(id: string): Promise<MediaJob>;
        wait(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<MediaJob | null>;
    };
    client: OpenVibeClient;
}

/**
 * Media's object API v2. Credentials: tokenClient (createServiceTokenClient; media.object.upload and
 * media.object.read for namespace `app`), apiKey, or a client carrying its own. Without baseUrl the Media
 * origin comes from the platform descriptor (live services only; otherwise sdk.service_unavailable).
 */
export declare function createObjectsClient(opts: {
    app: string;
    baseUrl?: string;
    tokenClient?: { getToken(ctx?: { audience?: string; scope?: string | string[] }): Promise<string>; invalidate?(ctx?: { audience?: string }): void };
    apiKey?: string;
    client?: OpenVibeClient;
    network?: string;
    discoveryUrl?: string;
    fetch?: typeof fetch;
    actingUserId?: string | number;
    subject?: string;
    /** Default 64 MiB. */
    multipartThreshold?: number;
    /** Default 16 MiB (Media accepts 5-256 MB by default). */
    partSize?: number;
    /** Parts in flight at once; default 4. */
    concurrency?: number;
    /** Whole-object sha256 is computed up to this size; default 256 MiB. */
    hashMaxBytes?: number;
    /** Extra rounds for parts that failed; default 3. */
    resumeRounds?: number;
    timeoutMs?: number;
    partTimeoutMs?: number;
}): ObjectsClient;
