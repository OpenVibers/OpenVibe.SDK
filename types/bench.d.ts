import type { OpenVibeClient } from './core';

export interface BenchOptions { actingSubject?: string; signal?: AbortSignal; }
export interface BenchDefaults extends BenchOptions { baseUrl?: string; }
export interface BenchKind { id: string; room: string; entry: string; judge: string; name: string; schema: Record<string, unknown>; metrics: unknown[]; created_at: string | null; }
export interface BenchTask { id: string; kind_id: string; prompt: string; task_class: string | null; public: boolean; created_by?: string; created_at: string; }
export interface BenchOffer { provider: string; model?: string | null; }
export interface BenchEntry {
    id: string; round_id: string; provider?: string; model?: string;
    route?: Record<string, unknown>; payload: Record<string, unknown>;
    cost_usd?: number; ms?: number; tokens?: number; error: string | null;
    ui_check: Record<string, unknown> | null; run_id: string | null; created_at: string;
}
export interface BenchRound {
    id: string; task_id: string; kind_id: string; offers: BenchOffer[]; status: string;
    seed: number; params: Record<string, unknown>; pool_fallback: boolean; receipt: unknown | null;
    created_by?: string; created_at: string; finished_at: string | null;
    entries?: BenchEntry[]; votes?: number; blind?: boolean;
    [field: string]: unknown;
}
export interface BenchJudgementInput {
    kind_id?: string; judge?: string; judge_name?: string; judge_version?: string;
    pair?: { left: string; right: string }; outcome?: 'left' | 'right' | 'tie' | 'both_bad' | 'draw'; score?: number;
}
export interface BenchBoard { kind_id: string; type: 'elo' | 'pareto' | 'cost'; category: string; period: string; rows: Array<Record<string, unknown>>; }
export interface BenchEval { id: string; owner: string; kind_id: string; name: string; test_suite: unknown[]; created_at: string; }
export interface BenchEvalRun { id: string; eval_id: string; offers: BenchOffer[]; status: string; created_at: string; [field: string]: unknown; }
export type BenchDatasetLine = ({ type: 'task' } & BenchTask) | ({ type: 'round' } & BenchRound) | ({ type: 'entry' } & BenchEntry) | ({ type: 'judgement' | 'rating' } & Record<string, unknown>);
export interface BenchMcpTool { name: string; description?: string; inputSchema: Record<string, unknown>; [field: string]: unknown; }

export interface BenchClient {
    kinds: {
        list(opts?: BenchOptions): Promise<{ count: number; kinds: BenchKind[] }>;
        get(kind: string, opts?: BenchOptions): Promise<{ kind: BenchKind }>;
    };
    tasks: {
        create(kind: string, task: { prompt: string; task_class?: string; public?: boolean }, opts?: BenchOptions): Promise<{ task: BenchTask }>;
        get(id: string, opts?: BenchOptions): Promise<{ task: BenchTask }>;
    };
    rounds: {
        create(taskId: string, round?: { offers?: BenchOffer[]; seed?: number }, opts?: BenchOptions): Promise<{ round: BenchRound }>;
        get(id: string, opts?: BenchOptions): Promise<{ round: BenchRound }>;
    };
    entries: {
        submit(roundId: string, entry: { provider?: string; model?: string; route?: Record<string, unknown>; payload?: Record<string, unknown>; cost_usd?: number; ms?: number; tokens?: number; error?: string | null; ui_check?: Record<string, unknown> | null; run_id?: string | null }, opts?: BenchOptions): Promise<{ entry: BenchEntry }>;
    };
    judgements: {
        next(query: { kind: string } & BenchOptions): Promise<{ round: { id: string; kind_id: string; prompt: string }; left: { id: string; payload: Record<string, unknown> }; right: { id: string; payload: Record<string, unknown> } } | { pair: null; detail: string }>;
        cast(roundId: string, judgement: BenchJudgementInput, opts?: BenchOptions): Promise<{ judgement: Record<string, unknown>; revealed: { left: BenchEntry; right: BenchEntry } | null }>;
    };
    boards: { get(kind: string, query?: { type?: 'elo' | 'pareto' | 'cost'; category?: string; period?: string } & BenchOptions): Promise<{ board: BenchBoard }> };
    models: { get(model: string, opts?: BenchOptions): Promise<{ model: string; ratings: Array<Record<string, unknown>>; entries: BenchEntry[]; total_cost_usd: number }> };
    datasets: {
        /** Raw application/x-ndjson text. */
        get(kind: string, opts?: BenchOptions): Promise<string>;
        /** Parses each JSONL object as bytes arrive and awaits onLine. */
        iterate(kind: string, onLine: (line: BenchDatasetLine) => void | Promise<void>, opts?: BenchOptions): Promise<void>;
    };
    evals: {
        create(evaluation: { kind_id: string; name: string; test_suite: unknown[] }, opts?: BenchOptions): Promise<{ eval: BenchEval }>;
        get(id: string, opts?: BenchOptions): Promise<{ eval: BenchEval }>;
        run(id: string, run?: { offers?: BenchOffer[] }, opts?: BenchOptions): Promise<{ run: BenchEvalRun }>;
        results(id: string, opts?: BenchOptions): Promise<{ eval: BenchEval; runs: BenchEvalRun[] }>;
    };
    mcpTools(opts?: BenchOptions): Promise<BenchMcpTool[]>;
}

export function createBenchClient(client: OpenVibeClient, defaults?: BenchDefaults): BenchClient;
