export type MetricKind = 'chat' | 'code' | 'design' | 'search' | 'vision' | 'speech' | 'embedding' | 'image' | 'video' | 'other';
export type MetricMeasure = 'success_rate' | 'latency_p50_ms' | 'latency_p95_ms' | 'ttft_p50_ms' | 'tokens_per_second_p50' | 'cost_per_run_usd' | 'cost_per_1k_output_tokens_usd';
export type MetricCell = Partial<Record<MetricMeasure, number | null>> & {
    day: string; model: string; provider: string; task_kind: MetricKind; runs: number;
    samples: { latency: number | null; ttft: number | null; throughput: number | null; cost: number | null };
    computed_at: string;
};
export interface MetricMetadata {
    schema: 'exchange.metrics@1'; minimum_samples: 20; source: string; methodology: string;
    measures: MetricMeasure[]; task_kinds: MetricKind[];
}
export interface ModelMetricSeries extends MetricMetadata {
    model: string; days: 30 | 90; from: string; to: string; kind: MetricKind | null; series: MetricCell[]; missing: string;
}
export interface MetricComparison extends MetricMetadata {
    day: string; kind: MetricKind | null; models: { model: string; cells: MetricCell[] }[];
}
export interface MetricLeaderboard extends MetricMetadata {
    day: string; kind: MetricKind; measure: MetricMeasure; direction: 'higher' | 'lower'; rows: MetricCell[];
}
export interface ModelPriceHistory {
    schema: 'exchange.prices@1'; model: string; days: 30 | 90; source: string; currency: 'USD'; per: '1M tokens';
    series: { day: string; model: string; provider: string; offer: string; price_in: number | null; price_out: number | null; price_cached: number | null; source: string | null; captured_at: string }[];
}
export interface ProviderHealth extends MetricMetadata {
    provider: string; days: 7; interval: 'hour'; from: string; to: string;
    series: { hour: string; provider: string; runs: number; success_rate: number; latency_p50_ms: number | null; latency_samples: number | null; computed_at: string }[];
}
export interface AiMetrics {
    status(opts?: { signal?: AbortSignal }): Promise<{ schema: 'exchange.metrics@1'; minimum_samples: 20; completed_through: string | null; completed_at: string | null; published_cells: number; first_day: string | null; last_day: string | null }>;
    model(model: string, query?: { days?: 30 | 90; kind?: MetricKind }, opts?: { signal?: AbortSignal }): Promise<ModelMetricSeries>;
    compare(query: { models: string[]; measures?: MetricMeasure[]; kind?: MetricKind; day?: string }, opts?: { signal?: AbortSignal }): Promise<MetricComparison>;
    leaderboard(query?: { kind?: MetricKind; measure?: MetricMeasure; day?: string }, opts?: { signal?: AbortSignal }): Promise<MetricLeaderboard>;
    prices(model: string, query?: { days?: 30 | 90 }, opts?: { signal?: AbortSignal }): Promise<ModelPriceHistory>;
    providerHealth(provider: string, opts?: { signal?: AbortSignal }): Promise<ProviderHealth>;
}
