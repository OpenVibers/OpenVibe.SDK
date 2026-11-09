import type { OpenVibeClient } from './core';
export interface ReportAI {
    leaderboard(opts?: { kind?: string; maker?: string; weights?: 'open' | 'closed'; price?: string; status?: 'current' | 'all'; uncensored?: boolean; community?: boolean; sort?: string; limit?: number; cursor?: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
    model(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    providers(options?: { signal?: AbortSignal }): Promise<unknown>;
    compare(ids: string | string[], options?: { signal?: AbortSignal }): Promise<unknown>;
    picks(options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface ReportClient { ai: ReportAI }
export declare function createReportClient(client: Pick<OpenVibeClient, 'json'>, options?: { baseUrl?: string }): ReportClient;
export declare const REPORT_URL: string;
