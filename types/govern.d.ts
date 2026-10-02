import type { Valkey } from './valkey';
export type CostUnit = 'browser-second' | 'ai-token' | 'ai-usd' | 'gpu-second' | 'video-minute' | 'bandwidth-byte' | 'storage-byte-day' | 'event'
    | 'watch-check' | 'bot-control-second' | 'job-run' | 'upload-byte' | 'download-byte';
export type Windowed = { minute?: number; hour?: number; day?: number; month?: number };
/** { [unit]: { [tier]: { minute?, hour?, day?, month? } } }: a missing tier or window is unlimited, 0 refuses. */
export type GovernPolicy = Partial<Record<CostUnit, Record<string, Windowed>>>;
export type Reserved = { ok: true; id: string; replay: boolean } | { ok: false; unit: CostUnit; window: string; limit: number; used: number; retryAfterS: number };
export interface Governor {
    reserve(o: { subject: string; tier?: string; unit: CostUnit; amount: number; key: string; project?: string | null;
        operation?: string; provider?: string; resource?: string; region?: string; trace_id?: string; route_epoch?: number }): Promise<Reserved>;
    commit(id: string, actual: number): Promise<boolean>;
    release(id: string): Promise<boolean>;
    usage(o: { subject: string; tier?: string; unit: CostUnit; project?: string | null }): Promise<Record<string, { used: number; limit: number }>>;
    lease(o: { subject: string; kind: string; max: number; ttlMs?: number }): Promise<{ ok: true; id: string; release(): Promise<void> } | { ok: false; retryAfterS: number }>;
    policy: GovernPolicy;
}
/** What onUsage gets on a new reservation: a platform.usage-sample@1 reading (no money fields; rating is Billing's). */
export interface UsageRecord {
    id: string; idempotency_key: string; service?: string; project?: string; subject: string; resource?: string; provider?: string; region?: string;
    operation: string; quantity: number; unit: CostUnit; at: string; route_epoch?: number; trace_id?: string; source: string;
}
export declare function createGovernor(opts?: { policy?: GovernPolicy; valkey?: Valkey | null; now?: () => number; reservationTtlMs?: number;
    onRefused?: (e: object) => void; onUsage?: (e: UsageRecord) => void;
    /** The spending service, e.g. 'openvibe.ai'. Without it a warning is logged and records lack `service`. */
    service?: string | null; provider?: string | null; resource?: string | null; region?: string | null;
    log?: { warn(...a: unknown[]): void } }): Governor;
export declare const WINDOWS: Record<'minute' | 'hour' | 'day' | 'month', number>;
export declare const UNITS: CostUnit[];
