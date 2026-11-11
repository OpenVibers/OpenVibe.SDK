/** openvibe-sdk/codes: OpenVibe.Codes — the person's coding tasks as the Dock's Code tab lists, starts and stops them. */
type Opts = { signal?: AbortSignal };
type CodesJson = Record<string, any>;
export type CodesTaskMode = 'create' | 'openvibe' | 'repo';
export type CodesTaskStatus = 'queued' | 'running' | 'needs-you' | 'done' | 'failed' | 'stopped';
export type CodesModelPreset = 'Fast' | 'Balanced' | 'Deep' | 'Council';
export type CodesModelEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface CodesModelPlan {
    mode: 'single' | 'pair' | 'council' | 'escalate';
    roles: Array<{ role: 'planner' | 'builder' | 'reviewer' | 'verifier'; model: string; effort: CodesModelEffort;
        samples?: number; budget?: { tokens?: number; minutes?: number; dollars?: number } }>;
    ladder?: string[];
    checks: { tests?: boolean; lint?: boolean; reviewer?: boolean };
}
export interface CodesTaskSummary {
    id: string; title: string; status: CodesTaskStatus; mode: CodesTaskMode; repo: string;
    started_at: string; updated_at: string; steps: number; url: string; preview_url: string | null; pr_url: string | null;
}
export interface CodesTaskCreate {
    text: string; mode: CodesTaskMode; repo?: string; attachments?: string[];
    plan?: CodesModelPlan; preset?: CodesModelPreset;
}
export interface CodesClient {
    tasks: {
        list(opts?: Opts & { limit?: number }): Promise<{ tasks: CodesTaskSummary[] }>;
        create(req: CodesTaskCreate, opts?: Opts): Promise<{ id: string | null; url: string }>;
        stop(id: string, opts?: Opts): Promise<{ ok: true }>;
    };
    modelPlans: {
        get(opts?: Opts & { project?: string }): Promise<{ account: CodesModelPlan; project: CodesModelPlan | null; effective: CodesModelPlan; source: 'account' | 'project' }>;
        put(plan: CodesModelPlan, opts?: Opts & { project?: string }): Promise<{ plan: CodesModelPlan; resolved: CodesModelPlan; fallbacks: unknown[]; prices: unknown[] }>;
        presets(opts?: Opts): Promise<{ presets: Record<CodesModelPreset, CodesModelPlan> }>;
    };
}
export declare function createCodesClient(client: CodesJson, opts?: { baseUrl?: string }): CodesClient;
