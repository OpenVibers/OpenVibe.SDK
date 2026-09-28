/** openvibe-sdk/cache — shared caching on Valkey, in-process without it; never authoritative (ADR-035). */
import type { Valkey } from './valkey';
export interface Cache {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlSec?: number, opts?: { tags?: string[] }): Promise<void>;
    del(...keys: string[]): Promise<number>;
    /** One load per key across processes (single-flight plus a short lock). */
    getOrSet<T>(key: string, ttlSec: number, loader: () => Promise<T>, opts?: { tags?: string[] }): Promise<T>;
    invalidateTag(tag: string): Promise<number>;
    stats(): { hits: number; misses: number; loads: number; errors: number; store: 'valkey' | 'memory' };
}
export function createCache(opts?: { valkey?: Valkey | null; namespace?: string; ttlSec?: number; lockMs?: number; waitMs?: number; memoryMax?: number; log?: { warn(msg: string): void } }): Cache;
