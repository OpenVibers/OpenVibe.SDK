import type { OpenVibeClient } from './core';

export type CodesRole = 'planner' | 'builder' | 'reviewer' | 'verifier';
export type CodesEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface CodesModelPlan {
    mode: 'single' | 'pair' | 'council' | 'escalate';
    roles: Array<{ role: CodesRole; model: string; effort: CodesEffort; samples?: number; budget?: { tokens?: number; minutes?: number; dollars?: number } }>;
    ladder?: string[];
    checks: { tests?: boolean; lint?: boolean; reviewer?: boolean };
}
export type CodesPreset = 'Fast' | 'Balanced' | 'Deep' | 'Council';
export interface CodesTaskCreate {
    repo: string;
    prompt: string;
    ref?: string;
    permission?: 'review' | 'edit' | 'full';
    plan?: CodesModelPlan;
    preset?: CodesPreset;
    idempotency_key?: string;
    push?: boolean;
    pull_request?: boolean;
}
export interface CodesClient {
    modelPlans: {
        get(options?: { project?: string; signal?: AbortSignal }): Promise<{ account: CodesModelPlan; project: CodesModelPlan | null; effective: CodesModelPlan; source: 'account' | 'project' }>;
        put(plan: CodesModelPlan, options?: { project?: string; signal?: AbortSignal }): Promise<{ plan: CodesModelPlan; resolved: CodesModelPlan; fallbacks: Array<{ role: CodesRole; requested: string; model: string; reason: string }>; prices: Array<{ role: CodesRole; model: string; output_nano_usd_per_m: string | null }> }>;
        presets(options?: { signal?: AbortSignal }): Promise<{ presets: Record<CodesPreset, CodesModelPlan> }>;
    };
    tasks: {
        create(body: CodesTaskCreate, options?: { signal?: AbortSignal }): Promise<{ task: { id: string; model_plan?: CodesModelPlan }; created: boolean }>;
        get(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    };
}
export function createCodesClient(client: OpenVibeClient, options?: { baseUrl?: string; actingSubject?: string }): CodesClient;
