import type { OpenVibeClient } from './core';

export interface AiRun { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string; workflow?: { key: string; version: number }; output?: unknown; error?: unknown; [field: string]: unknown; }
export interface RunOptions { wait?: number; version?: number; idempotencyKey?: string; target?: unknown; attribution?: unknown; onBehalfOf?: unknown; options?: Record<string, unknown>; signal?: AbortSignal; }
export interface RunResponse { run: AiRun; replayed?: boolean }
export interface AiRuns {
    create(workflow: string, input?: Record<string, unknown>, opts?: RunOptions): Promise<RunResponse>;
    list(query?: Record<string, string | number>, opts?: { signal?: AbortSignal }): Promise<{ runs: AiRun[]; [field: string]: unknown }>;
    get(id: string, opts?: { signal?: AbortSignal }): Promise<RunResponse | null>;
    cancel(id: string, opts?: { signal?: AbortSignal }): Promise<RunResponse>;
    retry(id: string, opts?: Pick<RunOptions, 'wait' | 'idempotencyKey' | 'signal'>): Promise<RunResponse>;
    citations(id: string, opts?: { signal?: AbortSignal }): Promise<{ citations: Array<Record<string, unknown>> }>;
    addCitations(id: string, citations: Array<Record<string, unknown>>, opts?: { signal?: AbortSignal }): Promise<{ citations: Array<Record<string, unknown>> }>;
    waitFor(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<AiRun>;
}
type Op = (input?: Record<string, unknown>, opts?: Omit<RunOptions, 'version' | 'onBehalfOf'>) => Promise<RunResponse>;
export interface AiClient { runs: AiRuns; TERMINAL: Set<string>; chat: Op; generate: Op; summarize: Op; classify: Op; extract: Op; enrich: Op; embed: Op; }
export function createAiClient(client: OpenVibeClient, defaults?: { baseUrl?: string }): AiClient;
export const TERMINAL: Set<string>;
export const OPS: string[];
