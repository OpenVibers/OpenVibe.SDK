/** openvibe-sdk/queue — durable at-least-once jobs on Valkey streams, in-process without Valkey (ADR-035). */
import type { Valkey } from './valkey';
export interface JobInfo { id: string; attempt: number; queue: string }
export interface Worker { stats(): { done: number; failed: number; retried: number; dead: number; active: number }; stop(timeoutMs?: number): Promise<void> }
export interface Queue {
    name: string;
    /** Returns the job id, 'delayed', or null when `id` was already queued in the last 24 hours. */
    add(data: unknown, opts?: { delayMs?: number; attempts?: number; id?: string }): Promise<string | null>;
    process(handler: (data: any, job: JobInfo) => Promise<unknown>, opts?: { concurrency?: number; visibilityMs?: number; blockMs?: number; backoffMs?: (attempt: number) => number }): Worker;
    stats(): Promise<{ waiting: number; pending: number; delayed: number; dead: number }>;
    dead(count?: number): Promise<{ id: string; data: any; attempts: number; error: string; at: string }[]>;
}
export function createQueue(opts: { valkey?: Valkey | null; name: string; group?: string; maxLen?: number; log?: object }): Queue;
export function backoff(attempt: number): number;
