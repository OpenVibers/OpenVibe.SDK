/** openvibe-sdk/quest: OpenVibe.Quest for developer apps — quests on your own events (contracts 0.193.0). */
export interface AppQuestStep { event_type: string; count: number; label: string }
export interface AppQuestRequest {
    title: string;
    why?: string;
    steps: AppQuestStep[];
    badge: { name: string };
    url?: string;
    status?: 'active' | 'retired';
}
export interface AppQuest {
    id: string; slug: string; project_id: string; app: string; env: 'sandbox' | 'production';
    title: string; why: string | null; steps: AppQuestStep[]; badge: { id: string; name: string }; url: string | null;
    status: 'active' | 'retired'; created_at: string; updated_at: string; completions: number;
}
export interface QuestClient {
    daily(opts?: { date?: string; signal?: AbortSignal }): Promise<DailyQuest>;
    myDaily(opts?: { signal?: AbortSignal }): Promise<DailyProgress>;
    stepTypes(opts?: { signal?: AbortSignal }): Promise<{ step_types: DailyStepType[] }>;
    contributeStepType(stepType: DailyStepTypeRequest, opts?: { signal?: AbortSignal }): Promise<DailyStepType>;
    appQuests: {
        define(slug: string, quest: AppQuestRequest, opts?: { signal?: AbortSignal }): Promise<AppQuest>;
        list(opts?: { signal?: AbortSignal }): Promise<{ project_id: string; max: number; quests: AppQuest[] }>;
        retire(slug: string, opts?: { signal?: AbortSignal }): Promise<AppQuest>;
    };
    eventType(projectId: string, name: string): string;
    projectKey(projectId: string): string;
}
export interface DailyStepType {
    id: string; event_type: string; site: string; sentence: string; href: string; weight: number;
    count: 1; verification: string; status: 'pending' | 'approved' | 'rejected'; source?: string;
}
export interface DailyStepTypeRequest {
    id: string; event_type: string; site: string; sentence: string; href: string; weight?: number;
}
export interface DailyQuest {
    date: string; title: string; story: string; steps: DailyStepType[];
    source: 'ai' | 'rotation'; finished_today: number;
}
export interface DailyProgress extends DailyQuest {
    steps: (DailyStepType & { progress: number; done: boolean })[];
    progress: number; completed: boolean; completed_at: string | null; streak: number; time_zone: string;
}
export function createQuestClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): QuestClient;
export function eventType(projectId: string, name: string): string;
export function projectKey(projectId: string): string;
