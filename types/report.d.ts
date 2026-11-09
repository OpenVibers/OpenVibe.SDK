import type { OpenVibeClient } from './core';

export interface ReportStatsWindow { days?: 7 | 30 | 90; signal?: AbortSignal; }
export interface ReportPublished {
    sites: boolean;
    activity: boolean;
    made: boolean;
    ai: boolean;
    money: boolean;
}
export interface ReportPerson {
    username: string;
    display_name: string;
    avatar_url?: string;
}
export interface ReportMeStats {
    generated_at: string;
    person: ReportPerson;
    window: { days: 7 | 30 | 90; from: string; to: string };
    published: ReportPublished;
    sections: {
        sites?: Record<string, unknown>;
        activity?: Record<string, unknown>;
        made?: Record<string, unknown>;
        ai?: Record<string, unknown>;
        money?: Record<string, unknown>;
    };
    note?: string;
}

export interface ReportAI {
    leaderboard(opts?: { kind?: string; maker?: string; weights?: 'open' | 'closed'; price?: string; status?: 'current' | 'all'; uncensored?: boolean; community?: boolean; sort?: string; limit?: number; cursor?: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
    model(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    providers(options?: { signal?: AbortSignal }): Promise<unknown>;
    compare(ids: string | string[], options?: { signal?: AbortSignal }): Promise<unknown>;
    picks(options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface ReportClient {
    /** The signed-in person's own numbers (report.me-stats@1). Needs their session token on the client. */
    me(options?: ReportStatsWindow): Promise<ReportMeStats>;
    /** One person's published numbers, by username; 404 when they published nothing. */
    person(username: string, options?: { signal?: AbortSignal }): Promise<ReportMeStats>;
    /** Set all five per-section switches and answer the recomputed document. */
    publish(published: ReportPublished, options?: ReportStatsWindow): Promise<ReportMeStats>;
    ai: ReportAI;
}
export declare function createReportClient(client: Pick<OpenVibeClient, 'json'>, options?: { baseUrl?: string }): ReportClient;
export declare const REPORT_URL: string;
export declare const DAYS: readonly number[];
export declare const SECTIONS: readonly string[];
