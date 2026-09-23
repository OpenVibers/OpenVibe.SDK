import type { OpenVibeClient, OpenVibeError } from './core';
import type { ToolDescriptor, ToolList, ToolsRun, ToolsJob } from './contracts';
import type { JobsClient, JobFile, JobEventsOptions, JobEvent } from './jobs';

export type { ToolDescriptor, ToolList, ToolsRunRequest, ToolsRun, ToolsJob } from './contracts';

/** A file that is already somewhere (tools.run-request@1 files). */
export type ToolFileRef =
    /** A Media object the caller may read. */
    | { media_id: string }
    /** Result file `index` of a job the same caller owns: one tool's output feeds the next. */
    | { job_id: string; index: number };
/** An upload (multipart `file` part) or a reference. */
export type ToolRunFile = JobFile | ToolFileRef;

/** GET /api/v1/tools/:id/schema: what the list's `$ref`s point at. */
export interface ToolSchema {
    $schema?: string;
    $id?: string;
    $defs: { input: Record<string, unknown> | null; output: Record<string, unknown> | null };
}

export interface ToolListQuery {
    family?: string;
    /** Name, summary and keywords. */
    q?: string;
    execution?: ToolDescriptor['execution'];
    /** Sent as api=true|false. */
    api?: boolean;
    status?: ToolDescriptor['status'];
    signal?: AbortSignal;
}

export interface ToolRunOptions {
    /** Uploads first, then references, in order; the count must fit the descriptor's files.min..max. */
    files?: ToolRunFile | ToolRunFile[];
    /** Job tools: wait up to this long (0..60000 ms) before answering; 200 finished, else 202. */
    waitMs?: number;
    /** 8-200 printable ASCII characters; generated when omitted (returned as `idempotencyKey`). */
    idempotencyKey?: string;
    signal?: AbortSignal;
    /** Per attempt. Default: the client's, raised to waitMs or the tool's known limits.timeoutMs, plus 10 s. */
    timeoutMs?: number;
}

export type ToolRunWaitOptions = JobEventsOptions & { onEvent?: (e: JobEvent) => void | Promise<void> };

/** tools.run@1 `result`: data (output kind json), text (kind text) or files (kind file or files: the job's result files). */
export type ToolRunResult = Extract<ToolsRun, { state: 'succeeded' }>['result'];

interface ToolRunBase {
    tool: string;
    /** The key the run was sent with (yours, or generated). */
    idempotencyKey: string;
    /** The answer was a replay of an earlier run under the same key (Idempotent-Replayed). */
    replayed: boolean;
    /**
     * Not enumerable. A finished run resolves to itself; a job follows its events and resolves to the
     * succeeded run, or throws ToolRunError (failed, cancelled). An aborted signal throws sdk.aborted.
     */
    wait(opts?: ToolRunWaitOptions): Promise<ToolRunSucceeded>;
}
export interface ToolRunSucceeded extends ToolRunBase {
    state: 'succeeded';
    result: ToolRunResult;
    took_ms: number;
    /** Set when the tool ran as a job. */
    job?: ToolsJob;
    /** The job on the gateway (/api/v1/jobs/:id), when the tool ran as a job. */
    location?: string;
}
export interface ToolRunPending extends ToolRunBase {
    state: 'queued' | 'running';
    job: ToolsJob;
    /** The job, as the server sent it (a path on the gateway, /api/v1/jobs/:id). */
    location: string;
}
export type ToolRunOutcome = ToolRunSucceeded | ToolRunPending;

/**
 * A run that finished `failed` or `cancelled`, with the tool's own problem+json mapped like any
 * OpenVibeError. `status` is the problem's status (422, 504…), not the HTTP status (200).
 * `isOpenVibeError(err)` is true.
 */
export declare class ToolRunError extends OpenVibeError {
    state: 'failed' | 'cancelled';
    tool: string;
    /** The job, when the tool ran as one (`jobs.retry(err.job.id)` when `retryable`). */
    job: ToolsJob | null;
    /** The tools.run@1 answer, when the failure came in one (null when it came from the job). */
    run: ToolsRun | null;
    constructor(init: { state: 'failed' | 'cancelled'; tool: string; error?: unknown; job?: ToolsJob | null; run?: ToolsRun | null; requestId?: string; traceId?: string });
}
export declare function isToolRunError(err: unknown): err is ToolRunError;

export interface ToolsClient {
    /** GET /api/v1/tools: tools.tool-list@1, schemas as { $ref }. */
    list(query?: ToolListQuery): Promise<ToolList>;
    /** GET /api/v1/tools/:id: the descriptor with its schemas embedded, or null. */
    get(id: string, opts?: { signal?: AbortSignal }): Promise<ToolDescriptor | null>;
    /** GET /api/v1/tools/:id/schema, or null. */
    schema(id: string, opts?: { signal?: AbortSignal }): Promise<ToolSchema | null>;
    /**
     * POST /api/v1/tools/:id/run. Resolves finished (succeeded) or pending (a job still queued or
     * running); throws ToolRunError when the run failed or was cancelled, OpenVibeError when it was
     * refused (404 tools.tool.not_found | not_runnable, 422 tools.input.invalid, 403, 429, 503…).
     */
    run(id: string, input?: Record<string, unknown>, opts?: ToolRunOptions): Promise<ToolRunOutcome>;
    /** openvibe-sdk/jobs on the same origin and credentials: the gateway's /api/v1/jobs facade. */
    jobs: JobsClient;
}

export interface ToolsClientOptions {
    /** Default: the `tools` origin from the platform descriptor (https://openvibe.tools). */
    baseUrl?: string;
    service?: string;
    audience?: string;
    /** Registry reads send no token (default true); false sends the client's token. */
    anonymousReads?: boolean;
}
export declare function createToolsClient(client: OpenVibeClient, opts?: ToolsClientOptions): ToolsClient;
