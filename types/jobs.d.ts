import type { OpenVibeClient } from './core';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Job {
    id: string;
    object: 'tools.job';
    service: string;
    type: string;
    type_version: number;
    state: JobState;
    progress: { percent: number | null; message: string | null };
    attempts: number;
    max_attempts: number;
    cancel_requested?: boolean;
    created_at?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
    expires_at?: string | null;
    result: { files: Array<{ name: string; mime: string; size: number; url: string; [k: string]: unknown }>; data: Record<string, unknown> } | null;
    error: { code: string; detail?: string; [k: string]: unknown } | null;
    retryable: boolean;
    links: { self: string; events: string; cancel: string | null };
    [field: string]: unknown;
}
export interface JobEvent { id: number | null; event: string; job: Job | null; }
export type JobFile = Blob | { name?: string; data: Blob | ArrayBuffer | ArrayBufferView | string; type?: string };
export interface SubmitJob {
    type: string;
    input?: Record<string, unknown>;
    files?: JobFile | JobFile[];
    /** Same key + same request = same job. Generated when omitted (returned). */
    idempotencyKey?: string;
    signal?: AbortSignal;
}
export interface JobEventsOptions { lastEventId?: number | string; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number; }
export interface JobsClient {
    submit(input: SubmitJob): Promise<{ job: Job; replayed: boolean; idempotencyKey: string }>;
    get(id: string, opts?: { signal?: AbortSignal }): Promise<Job | null>;
    cancel(id: string, opts?: { signal?: AbortSignal }): Promise<Job>;
    events(id: string, opts?: JobEventsOptions): AsyncGenerator<JobEvent, void, unknown>;
    wait(id: string, opts?: JobEventsOptions & { onEvent?: (e: JobEvent) => void | Promise<void> }): Promise<Job | null>;
    /** The raw Response of a result file (body unread). */
    file(id: string, n?: number, opts?: { signal?: AbortSignal; inline?: boolean }): Promise<Response>;
}
/** baseUrl: the satellite that runs the job type (e.g. https://img.openvibe.tools); default the registry's `tools` origin. */
export declare function createJobsClient(client: OpenVibeClient, opts?: { baseUrl?: string; service?: string; audience?: string }): JobsClient;
export declare function isTerminal(job: Pick<Job, 'state'> | null | undefined): boolean;
export declare const TERMINAL_STATES: JobState[];
