import type { Valkey } from './valkey';
export type CostUnit = 'browser-second' | 'ai-token' | 'ai-usd' | 'gpu-second' | 'video-minute' | 'bandwidth-byte' | 'storage-byte-day' | 'event'
    | 'watch-check' | 'bot-control-second' | 'job-run' | 'upload-byte' | 'download-byte';
export type Windowed = { minute?: number; hour?: number; day?: number; month?: number };
/** { [unit]: { [tier]: { minute?, hour?, day?, month? } } }: a missing tier or window is unlimited, 0 refuses. */
export type GovernPolicy = Partial<Record<CostUnit, Record<string, Windowed>>>;
export type Reserved = { ok: true; id: string; replay: boolean } | { ok: false; unit: CostUnit; window: string; limit: number; used: number; retryAfterS: number };
export interface Governor {
    reserve(o: { subject: string; tier?: string; unit: CostUnit; amount: number; key: string; project?: string | null }): Promise<Reserved>;
    commit(id: string, actual: number): Promise<boolean>;
    release(id: string): Promise<boolean>;
    usage(o: { subject: string; tier?: string; unit: CostUnit; project?: string | null }): Promise<Record<string, { used: number; limit: number }>>;
    lease(o: { subject: string; kind: string; max: number; ttlMs?: number }): Promise<{ ok: true; id: string; release(): Promise<void> } | { ok: false; retryAfterS: number }>;
    policy: GovernPolicy;
}
export declare function createGovernor(opts?: { policy?: GovernPolicy; valkey?: Valkey | null; now?: () => number; reservationTtlMs?: number;
    onRefused?: (e: object) => void; onUsage?: (e: object) => void }): Governor;
export declare const WINDOWS: Record<'minute' | 'hour' | 'day' | 'month', number>;
export declare const UNITS: CostUnit[];
