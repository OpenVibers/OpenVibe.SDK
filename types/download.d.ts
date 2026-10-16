/** openvibe-sdk/download: OpenVibe.Download, a person's drive — list, folders, uploads in parts, and sync() backups. */
export interface DriveFile { id: string; name: string; size: number; content_type: string; sha256: string | null; folder_id: string | null; created_at: string }
export interface DriveFolder { id: string; name: string; parent_id: string | null; created_at: string }
export interface DriveUsage { bytes_used: number; bytes_limit: number; max_file_bytes: number; files: number; uploads_today: number; uploads_per_day: number }
export interface SyncEvent { type: 'upload' | 'replace' | 'same' | 'skip' | 'folder' | 'delete' | 'error'; path: string; size?: number; reason?: string; code?: string | null; message?: string; dryRun?: boolean }
export interface SyncReport {
    uploaded: number; replaced: number; skipped: number; deleted: number; failed: number; bytes: number;
    errors: { path: string; code: string | null; message: string }[];
    stopped?: { code: string; message: string };
}
export interface DownloadClient {
    files: {
        list(opts?: { folderId?: string | null; limit?: number; before?: string | null }): Promise<{ folder_id: string | null; folders: DriveFolder[]; files: DriveFile[]; usage: DriveUsage }>;
        all(opts?: { folderId?: string | null }): Promise<DriveFile[]>;
        get(id: string): Promise<{ file: DriveFile }>;
        remove(id: string): Promise<unknown>;
    };
    folders: {
        list(): Promise<DriveFolder[]>;
        create(name: string, parentId?: string | null): Promise<DriveFolder>;
        ensurePath(drivePath: string, opts?: { known?: DriveFolder[] }): Promise<string | null>;
    };
    upload(input: { path?: string; data?: Uint8Array | string; name?: string; folderId?: string | null; contentType?: string }): Promise<DriveFile>;
    usage(): Promise<DriveUsage>;
    sync(dir: string, opts?: { to?: string; delete?: boolean; dryRun?: boolean; exclude?: string[]; onEvent?: (e: SyncEvent) => void }): Promise<SyncReport>;
}
export function createDownloadClient(options: { key?: string; token?: string; baseUrl?: string; client?: unknown; sleep?: (ms: number) => Promise<void> }): DownloadClient;
export function contentTypeOf(name: string): string;
