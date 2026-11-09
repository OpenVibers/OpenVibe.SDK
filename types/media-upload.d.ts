import type { createObjectsClient, UploadBody, ObjectUploadOptions, MediaObject, ObjectUploadRef, ObjectsClient } from './media';

/** A ready-to-use multipart client with 8 MiB parts and three concurrent requests. */
export declare function createUploadClient(opts: Parameters<typeof createObjectsClient>[0]): {
    upload(file: UploadBody, options?: ObjectUploadOptions): Promise<MediaObject>;
    resume(ref: ObjectUploadRef, file: UploadBody, options?: { signal?: AbortSignal; onProgress?: ObjectUploadOptions['onProgress']; contentHash?: string | false }): Promise<MediaObject>;
    objects: ObjectsClient;
};
