import type { AiMetrics } from './ai-metrics';
export type * from './ai-metrics';
import type { OpenVibeClient } from './core';

export interface AiRun { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string; workflow?: { key: string; version: number }; output?: unknown; error?: unknown; latency_class?: LatencyClass; service_tier?: ServiceTier | null; latency_clamped?: { asked: LatencyClass; used: LatencyClass } | null; [field: string]: unknown; }
export interface AiFile { id: string; name: string; media_type: string; size: number; storage: { provider: 'media'; key: string }; access: { readers: string[] }; read: { method: 'text' | 'pages' | 'image' | 'audio_transcript' | 'not_readable'; content?: string; pages?: string[]; reason?: string }; role?: 'input' | 'artifact'; }
export interface AiTurnMessage { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string | null; files?: AiFile[]; }
export interface AiOutputFile { name: string; media_type: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json'; }
export interface AiTurnRequest { messages: AiTurnMessage[]; files?: Array<AiFile | Pick<AiFile, 'id'>>; output_file?: AiOutputFile; model?: string; max_tokens?: number; }
export interface AiTurnResult { content?: string; choices?: Array<{ index: number; message: { role: 'assistant'; content: string | null; artifacts?: AiFile[] }; finish_reason?: string | null }>; artifacts?: AiFile[]; model?: string | null; }
export interface AiTurnResponse { run: AiRun & { output?: AiTurnResult }; replayed?: boolean; }
export interface AiFiles { attach(data: Blob | ArrayBuffer | ArrayBufferView | string, opts?: { filename?: string; mediaType?: string; subject?: string; signal?: AbortSignal; [option: string]: unknown }): Promise<AiFile>; list(opts?: Record<string, unknown>): Promise<{ files: AiFile[]; [field: string]: unknown }>; read(id: string, opts?: { ttl?: number; signal?: AbortSignal }): Promise<{ file: unknown; bytes: Uint8Array }>; remove(id: string): Promise<boolean>; }
/** How long the caller may wait: interactive (as soon as the provider can), background (minutes, priced on the cheapest tier that can wait), batch (hours, answered through the provider's own batch API). */
export type LatencyClass = 'interactive' | 'background' | 'batch';
/** The tier a run was priced on: the one the provider served (standard, flex, batch) or the one the router chose (offpeak, local). */
export type ServiceTier = 'standard' | 'flex' | 'batch' | 'offpeak' | 'local';
export interface AiChoice { model: string; source: "openvibe" | "keys" | "machines"; machine?: string; }
export interface AiTask { name: string; kind: "text" | "code" | "vision" | "image" | "search"; sentence: string; default: AiChoice; workflow?: string; service?: string; }
export interface AiTaskDefaults { signed_out: AiChoice; signed_in: AiChoice; fallbacks: AiChoice[]; image_model: AiChoice | null; search_engines: Array<{ engine: string; enabled: boolean }>; max_cost_usd: number | null; }
/** One thing AI can make, as GET /api/v1/creations lists it (ai.creation@1). */
export interface AiCreation {
    id: string;
    product: 'ai' | 'blog' | 'codes' | 'community' | 'design' | 'food' | 'games' | 'live' | 'media' | 'meme' | 'news' | 'pics' | 'quest' | 'rent' | 'reviews' | 'space' | 'tools' | 'trade' | 'wiki' | string;
    name: string;
    gives: string;
    returns: string;
    workflow: string | null;
    task: string | null;
    access: { guest: boolean; signed_in: boolean; floor_18: boolean };
    costs_coins: boolean;
    start_url: string;
}
export interface AiCreationList { creations: AiCreation[]; count: number; generated_at: string; }
export interface RunOptions { choice?: AiChoice; task?: string; wait?: number; version?: number; idempotencyKey?: string; target?: unknown; attribution?: unknown; onBehalfOf?: unknown; /** The class the caller asks for. A slower class than the workflow allows is honoured; a faster one is clamped by the service. */ latency?: LatencyClass; /** For a batch run: how long the answer may take, in hours (1 to 72). */ deadlineHours?: number; options?: Record<string, unknown>; signal?: AbortSignal; }
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
    error_code?: string | null; error_detail?: string | null;
    /** The plain note about the prompt: it expired (it was not charged), it was cancelled before it ran (it was not charged), or it was already sent to the provider (it finishes and is charged). */
    reason?: string | null; capacity?: string | null;
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
    /** Cancels a batch: only the prompts that never had a run are cancelled, and nothing is charged for them; a prompt that already has a run goes on and settles on its own path. */
    cancel(id: string, opts?: { signal?: AbortSignal }): Promise<{ batch: AiBatch }>;
}
type Op = (input?: Record<string, unknown>, opts?: Omit<RunOptions, 'version' | 'onBehalfOf'>) => Promise<RunResponse>;
export interface AiClient { metrics: AiMetrics; tasks(opts?: {signal?: AbortSignal}): Promise<{tasks: AiTask[]}>; creations(opts?: {signal?: AbortSignal}): Promise<AiCreationList>; run(task: string, input?: Record<string, unknown>, opts?: RunOptions): Promise<RunResponse>; turn(input: AiTurnRequest, opts?: RunOptions): Promise<AiTurnResponse>; choices: { get(task: string, opts?: {signal?: AbortSignal}): Promise<{task: AiTask; choice: AiChoice; why: string; options: Record<string, unknown[]>}>; set(task: string, choice: AiChoice, opts?: {signal?: AbortSignal}): Promise<{choice: AiChoice}> }; admin: { defaults(value?: {defaults: Array<{task: string; value: AiTaskDefaults}>}, opts?: {signal?: AbortSignal}): Promise<{tasks?: AiTask[]; defaults: Record<string, AiTaskDefaults>}> }; runs: AiRuns; batches: AiBatches; files: AiFiles; TERMINAL: Set<string>; CLASSES: string[]; chat: Op; generate: Op; summarize: Op; classify: Op; extract: Op; enrich: Op; embed: Op; }
export function createAiClient(client: OpenVibeClient, defaults?: { baseUrl?: string; media?: Record<string, unknown> & { app: string; subject?: string }; objectsClient?: { upload: Function; list: Function; signedUrl: Function; get: Function; delete: Function }; fetch?: typeof fetch }): AiClient;
export const TERMINAL: Set<string>;
export const OPS: string[];
export const CLASSES: string[];
