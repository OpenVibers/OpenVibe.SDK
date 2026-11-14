import type { OpenVibeClient } from './core';

export interface CompareOptions { actingSubject?: string; signal?: AbortSignal; }
export interface CompareDefaults extends CompareOptions { baseUrl?: string; }
export interface CompareKind { id: string; room: string; entry: string; judge: string; name: string; schema: Record<string, unknown>; metrics: unknown[]; created_at: string | null; }
export interface CompareTask { id: string; kind_id: string; prompt: string; task_class: string | null; public: boolean; created_by?: string; created_at: string; }
export interface CompareOffer { provider: string; model?: string | null; }
export interface CompareEntry {
    id: string; round_id: string; provider?: string; model?: string;
    route?: Record<string, unknown>; payload: Record<string, unknown>;
    cost_usd?: number; ms?: number; tokens?: number; error: string | null;
    ui_check: Record<string, unknown> | null; run_id: string | null; created_at: string;
}
export interface CompareRound {
    id: string; task_id: string; kind_id: string; offers: CompareOffer[]; status: string;
    seed: number; params: Record<string, unknown>; pool_fallback: boolean; receipt: unknown | null;
    created_by?: string; created_at: string; finished_at: string | null;
    entries?: CompareEntry[]; votes?: number; blind?: boolean;
    [field: string]: unknown;
}
export interface CompareJudgementInput {
    kind_id?: string; judge?: string; judge_name?: string; judge_version?: string;
    pair?: { left: string; right: string }; outcome?: 'left' | 'right' | 'tie' | 'both_bad' | 'draw'; score?: number;
}
export interface CompareBoard { kind_id: string; type: 'elo' | 'pareto' | 'cost'; category: string; period: string; rows: Array<Record<string, unknown>>; }
export interface CompareRating {
    kind_id: string; category: string; subject: string; elo: number; games: number;
    wins: number; losses: number; ties: number; win_rate: number; provisional: boolean;
    ci_lower: number | null; ci_upper: number | null;
    rank: number | null; rank_lo: number | null; rank_hi: number | null;
}
export interface CompareSharedRatings {
    schema: 'bench.ratings@1'; kind_id: string; category: string; type: 'elo'; adult: false;
    minimum_samples: 20; source: string; methodology: string; rows: CompareRating[];
}
export interface CompareEval { id: string; owner: string; kind_id: string; name: string; test_suite: unknown[]; created_at: string; }
export interface CompareEvalRun { id: string; eval_id: string; offers: CompareOffer[]; status: string; created_at: string; [field: string]: unknown; }
export type CompareDatasetLine = ({ type: 'task' } & CompareTask) | ({ type: 'round' } & CompareRound) | ({ type: 'entry' } & CompareEntry) | ({ type: 'judgement' | 'rating' } & Record<string, unknown>);
export interface CompareMcpTool { name: string; description?: string; inputSchema: Record<string, unknown>; [field: string]: unknown; }

export interface CompareClient {
    kinds: {
        list(opts?: CompareOptions): Promise<{ count: number; kinds: CompareKind[] }>;
        get(kind: string, opts?: CompareOptions): Promise<{ kind: CompareKind }>;
    };
    tasks: {
        create(kind: string, task: { prompt: string; task_class?: string; public?: boolean }, opts?: CompareOptions): Promise<{ task: CompareTask }>;
        get(id: string, opts?: CompareOptions): Promise<{ task: CompareTask }>;
    };
    rounds: {
        create(taskId: string, round?: { offers?: CompareOffer[]; seed?: number }, opts?: CompareOptions): Promise<{ round: CompareRound }>;
        get(id: string, opts?: CompareOptions): Promise<{ round: CompareRound }>;
    };
    entries: {
        submit(roundId: string, entry: { provider?: string; model?: string; route?: Record<string, unknown>; payload?: Record<string, unknown>; cost_usd?: number; ms?: number; tokens?: number; error?: string | null; ui_check?: Record<string, unknown> | null; run_id?: string | null }, opts?: CompareOptions): Promise<{ entry: CompareEntry }>;
    };
    judgements: {
        next(query: { kind: string } & CompareOptions): Promise<{ round: { id: string; kind_id: string; prompt: string }; left: { id: string; payload: Record<string, unknown> }; right: { id: string; payload: Record<string, unknown> } } | { pair: null; detail: string }>;
        cast(roundId: string, judgement: CompareJudgementInput, opts?: CompareOptions): Promise<{ judgement: Record<string, unknown>; revealed: { left: CompareEntry; right: CompareEntry } | null }>;
    };
    boards: { get(kind: string, query?: { type?: 'elo' | 'pareto' | 'cost'; category?: string; period?: string } & CompareOptions): Promise<{ board: CompareBoard }> };
    /** Public fitted ratings. Models below twenty eligible games are omitted. No identity is sent. */
    ratings: { get(kind: string, query?: { category?: string; signal?: AbortSignal }): Promise<{ board: CompareSharedRatings }> };
    models: { get(model: string, opts?: CompareOptions): Promise<{ model: string; ratings: CompareRating[]; ratings_minimum_samples?: number; entries: CompareEntry[]; total_cost_usd: number }> };
    datasets: {
        /** Raw application/x-ndjson text. */
        get(kind: string, opts?: CompareOptions): Promise<string>;
        /** Parses each JSONL object as bytes arrive and awaits onLine. */
        iterate(kind: string, onLine: (line: CompareDatasetLine) => void | Promise<void>, opts?: CompareOptions): Promise<void>;
    };
    evals: {
        create(evaluation: { kind_id: string; name: string; test_suite: unknown[] }, opts?: CompareOptions): Promise<{ eval: CompareEval }>;
        get(id: string, opts?: CompareOptions): Promise<{ eval: CompareEval }>;
        run(id: string, run?: { offers?: CompareOffer[] }, opts?: CompareOptions): Promise<{ run: CompareEvalRun }>;
        results(id: string, opts?: CompareOptions): Promise<{ eval: CompareEval; runs: CompareEvalRun[] }>;
    };
    mcpTools(opts?: CompareOptions): Promise<CompareMcpTool[]>;
}

export function createCompareClient(client: OpenVibeClient, defaults?: CompareDefaults): CompareClient;
