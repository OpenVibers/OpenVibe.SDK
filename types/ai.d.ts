import type { OpenVibeClient } from './core';

export interface AiRun { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string; workflow?: { key: string; version: number }; output?: unknown; error?: unknown; latency_class?: LatencyClass; service_tier?: ServiceTier | null; latency_clamped?: { asked: LatencyClass; used: LatencyClass } | null; [field: string]: unknown; }
/** How long the caller may wait: interactive (as soon as the provider can), background (minutes, priced on the cheapest tier that can wait), batch (hours, answered through the provider's own batch API). */
export type LatencyClass = 'interactive' | 'background' | 'batch';
/** The tier a run was priced on: the one the provider served (standard, flex, batch) or the one the router chose (offpeak, local). */
export type ServiceTier = 'standard' | 'flex' | 'batch' | 'offpeak' | 'local';
export interface RunOptions { wait?: number; version?: number; idempotencyKey?: string; target?: unknown; attribution?: unknown; onBehalfOf?: unknown; /** The class the caller asks for. A slower class than the workflow allows is honoured; a faster one is clamped by the service. */ latency?: LatencyClass; /** For a batch run: how long the answer may take, in hours (1 to 72). */ deadlineHours?: number; options?: Record<string, unknown>; signal?: AbortSignal; }
export interface RunResponse { run: AiRun; replayed?: boolean }
export interface AiRuns {
    create(workflow: string, input?: Record<string, unknown>, opts?: RunOptions): Promise<RunResponse>;
    list(query?: Record<string, string | number>, opts?: { signal?: AbortSignal }): Promise<{ runs: AiRun[]; [field: string]: unknown }>;
    get(id: string, opts?: { signal?: AbortSignal }): Promise<RunResponse | null>;
    cancel(id: string, opts?: { signal?: AbortSignal }): Promise<RunResponse>;
    retry(id: string, opts?: Pick<RunOptions, 'wait' | 'idempotencyKey' | 'signal'>): Promise<RunResponse>;
    citations(id: string, opts?: { signal?: AbortSignal }): Promise<{ citations: Array<Record<string, unknown>> }>;
    addCitations(id: string, citations: Array<Record<string, unknown>>, opts?: { signal?: AbortSignal }): Promise<{ citations: Array<Record<string, unknown>> }>;
    /** Polls until the run finishes; a batch run that is not finished when the wait is over comes back pending (its status says where it stands) instead of throwing. */
    waitFor(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<AiRun>;
}
export interface AiBatchItem {
    idx: number;
    status: 'queued' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | string;
    model?: string | null; run_id?: string | null; answer?: string | null;
    error_code?: string | null; error_detail?: string | null; reason?: string | null; capacity?: string | null;
    route_provider?: string | null; route_model?: string | null;
    cost_nano_usd?: string | null; absorbed_nano_usd?: string | null; charged_nano_usd?: string | null;
    deadline_at?: string; created_at?: string; updated_at?: string;
    [field: string]: unknown;
}
export interface AiBatch {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | string;
    owner_type?: 'user' | 'app' | 'service' | string; owner_id?: string; project_id?: string | null;
    item_count?: number; items?: AiBatchItem[]; discount?: string;
    deadline_at?: string; created_at?: string; updated_at?: string; finished_at?: string | null;
    absorbed_nano_usd?: string | null; ran_on_regular_capacity?: boolean;
    [field: string]: unknown;
}
export interface AiBatches {
    /** Opens a batch of many prompts, answered later at half the retail price → { batch } */
    create(items: Array<string | { prompt: string; model?: string }>, opts?: { model?: string; deadlineHours?: number; idempotencyKey?: string; signal?: AbortSignal }): Promise<{ batch: AiBatch }>;
    list(query?: Record<string, string | number>, opts?: { signal?: AbortSignal }): Promise<{ batches: AiBatch[]; [field: string]: unknown }>;
    get(id: string, opts?: { signal?: AbortSignal }): Promise<{ batch: AiBatch } | null>;
    cancel(id: string, opts?: { signal?: AbortSignal }): Promise<{ batch: AiBatch }>;
}
type Op = (input?: Record<string, unknown>, opts?: Omit<RunOptions, 'version' | 'onBehalfOf'>) => Promise<RunResponse>;
export interface AiClient { runs: AiRuns; batches: AiBatches; TERMINAL: Set<string>; CLASSES: string[]; chat: Op; generate: Op; summarize: Op; classify: Op; extract: Op; enrich: Op; embed: Op; }
export function createAiClient(client: OpenVibeClient, defaults?: { baseUrl?: string }): AiClient;
export const TERMINAL: Set<string>;
export const OPS: string[];
export const CLASSES: string[];
