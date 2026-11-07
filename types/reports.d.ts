/** openvibe-sdk/reports: a session report from any agent harness (Agent Streams S3/S7). */
type Opts = { signal?: AbortSignal };
export type ReportSource = 'codes' | 'actor' | 'desk' | 'node';
export type ReportOutcome = 'done' | 'stopped' | 'failed';
export type ReportVisibility = 'private' | 'unlisted' | 'public';
export interface ReportTask {
    ref: string;
    title: string;
    url?: string;
}
export interface ReportStep {
    at?: string | Date;
    title: string;
    status?: 'started' | 'passed' | 'failed' | 'skipped';
    detail?: string;
    tests?: { passed: number; failed: number };
    cost_usd?: number;
}
export interface ReportOutput {
    kind?: 'pr' | 'file' | 'page' | 'deploy' | 'clip' | 'vod';
    title: string;
    url?: string;
    state?: string;
}
export interface SessionReportWrite {
    source: ReportSource;
    task: ReportTask;
    summary: string;
    outcome?: ReportOutcome;
    visibility?: ReportVisibility;
    worked_seconds?: number;
    cost_usd?: number;
    started_at?: string;
    ended_at?: string;
    timeline?: ReportStep[];
    outputs?: ReportOutput[];
    highlights?: string[];
    proof?: {
        tests?: { passed: number; failed: number };
        screenshots?: string[];
        review?: { verdict: string; notes?: string };
    };
}
export interface ReportsClient {
    /** Write a session report → { id, url, created }. Private unless visibility says otherwise. */
    write(report: SessionReportWrite, opts?: Opts): Promise<{ id: string; url: string; created: boolean }>;
    /** One report the caller may see. */
    read(id: string, opts?: Opts): Promise<Record<string, unknown>>;
}
export declare function createReportsClient(client: object, opts?: { baseUrl?: string }): ReportsClient;
export declare function cleanReport(report?: SessionReportWrite): Record<string, unknown>;
