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
export interface CodesUsageWindow { name: string; used_pct: number | null; resets_at: string | null }
export interface CodesAgentUsage { agent: string; name: string; state: string; windows: CodesUsageWindow[]; take?: boolean; why?: string; window?: string | null }
export interface CodesSpareSettings { enabled: boolean; reset_within_hours: number; min_left_pct: number; keep_pct: number; max_running: number; agents: string[] | null }
export interface CodesSpareTask {
    id: string; title: string; prompt: string; repo: string; agent: string; priority: number; repeat: boolean;
    state: 'queued' | 'running' | 'done' | 'failed' | 'paused'; task_id: string | null; last_agent: string | null; last_window: string | null;
    note: string | null; runs: number; created_at: string; started_at: string | null; ended_at: string | null;
}
export interface CodesClient {
    usage(opts?: Opts): Promise<{ agents: CodesAgentUsage[]; spare: { enabled: boolean; queued: number } }>;
    spare: {
        get(opts?: Opts): Promise<{ settings: CodesSpareSettings; tasks: CodesSpareTask[]; agents: CodesAgentUsage[] }>;
        settings(settings: Partial<CodesSpareSettings>, opts?: Opts): Promise<{ settings: CodesSpareSettings }>;
        add(task: { prompt: string; repo: string; title?: string; agent?: string; priority?: number; repeat?: boolean }, opts?: Opts): Promise<{ task: CodesSpareTask }>;
        update(id: string, patch: Partial<Pick<CodesSpareTask, 'title' | 'prompt' | 'repo' | 'agent' | 'priority' | 'repeat'>> & { state?: 'queued' | 'paused' }, opts?: Opts): Promise<{ task: CodesSpareTask }>;
        remove(id: string, opts?: Opts): Promise<unknown>;
    };
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
