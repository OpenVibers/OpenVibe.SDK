/** openvibe-sdk/valkey — the shared Valkey connection, confined to the service prefix (ADR-035). */
export interface Valkey {
    /** The iovalkey client (auto-pipelined). */
    client: any;
    prefix: string;
    /** The full key or channel name inside the prefix. */
    key(...parts: string[]): string;
    duplicate(): any;
    ready(): Promise<{ ok: true; detail: { store: 'valkey' } } | { ok: false; error: string }>;
    close(): Promise<void>;
}
/** null when no URL is configured (the cache, limits, queue and pubsub modules then run in-process). */
export function createValkey(opts?: { url?: string; prefix?: string; lazyConnect?: boolean; log?: { warn(msg: string): void }; client?: any }): Valkey | null;
