import type { OpenVibeClient } from './core';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** A Tools job (tools.job@1; ToolsJob in ./contracts is the exact contract type). */
export interface Job {
    id: string;
    object: 'tools.job';
    service: string;
    /** The tool whose run created the job (POST /api/v1/tools/:id/run). */
    tool?: string;
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
    /** problem+json (errors.problem@1): type, title, status, code, detail. */
    error: { code: string; status?: number; title?: string; type?: string; detail?: string; [k: string]: unknown } | null;
    retryable: boolean;
    /** The failed job this one retries. */
    retry_of?: string | null;
    /** The job that retried this failed one. */
    retried_by?: string | null;
    /** What keeps the result (expires_at is null while any remains). */
    references?: Array<{ ref: string; created_at: string }>;
    links: { self: string; events: string; cancel: string | null; retry?: string | null; retried_by?: string | null };
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
    /**
     * POST /api/v1/jobs/:id/retry: a failed job as a new job (retry_of). Asking again returns the same
     * retry (`replayed: true`). 409 tools.job.not_failed for other states.
     */
    retry(id: string, opts?: { signal?: AbortSignal }): Promise<{ job: Job; replayed: boolean }>;
    /** PUT /api/v1/jobs/:id/references/:ref (<service>:<kind>:<id>): keep a succeeded job's result. Idempotent. */
    reference(id: string, ref: string, opts?: { signal?: AbortSignal }): Promise<Job>;
    /** DELETE /api/v1/jobs/:id/references/:ref: after the last reference the result expires again. Idempotent. */
    unreference(id: string, ref: string, opts?: { signal?: AbortSignal }): Promise<Job>;
}
/**
 * Default origin: the registry's `tools` origin (https://openvibe.tools), whose gateway fronts every
 * satellite's jobs under /api/v1/jobs (ADR-027; needs the Tools run-API release, S6). Until then,
 * or to reach one satellite directly, pass baseUrl (e.g. https://img.openvibe.tools).
 */
export declare function createJobsClient(client: OpenVibeClient, opts?: { baseUrl?: string; service?: string; audience?: string }): JobsClient;
export declare function isTerminal(job: Pick<Job, 'state'> | null | undefined): boolean;
export declare const TERMINAL_STATES: JobState[];
