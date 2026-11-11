/** openvibe-sdk/codes: OpenVibe.Codes — the person's coding tasks as the Dock's Code tab lists, starts and stops them. */
type Opts = { signal?: AbortSignal };
type CodesJson = Record<string, any>;
export type CodesTaskMode = 'create' | 'openvibe' | 'repo';
export type CodesTaskStatus = 'queued' | 'running' | 'needs-you' | 'done' | 'failed' | 'stopped';
export interface CodesTaskSummary {
    id: string; title: string; status: CodesTaskStatus; mode: CodesTaskMode; repo: string;
    started_at: string; updated_at: string; steps: number; url: string; preview_url: string | null; pr_url: string | null;
}
export interface CodesTaskCreate {
    text: string; mode: CodesTaskMode; repo?: string; attachments?: string[];
}
export interface CodesClient {
    tasks: {
        list(opts?: Opts & { limit?: number }): Promise<{ tasks: CodesTaskSummary[] }>;
        create(req: CodesTaskCreate, opts?: Opts): Promise<{ id: string | null; url: string }>;
        stop(id: string, opts?: Opts): Promise<{ ok: true }>;
    };
}
export declare function createCodesClient(client: CodesJson, opts?: { baseUrl?: string }): { tasks: CodesClient['tasks'] };
