/** openvibe-sdk/quest: OpenVibe.Quest for developer apps — quests on your own events (contracts 0.193.0). */
import type { QuestDaily, QuestDailyProgress, QuestStepType, QuestStepTypeRequest } from './contracts';
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
export interface QuestCardData {
    signed_in: boolean;
    quest: QuestDaily;
    more: {
        quests?: number;
        sites?: number;
        mine?: { badges: number; in_progress: number; completed: number };
    };
}
export interface QuestCardOptions {
    token?: string | null;
    timeZone?: string;
}
export interface QuestClient {
    daily(opts?: { date?: string; signal?: AbortSignal }): Promise<DailyQuest>;
    today(opts?: { signal?: AbortSignal }): Promise<DailyProgress>;
    myDaily(opts?: { signal?: AbortSignal }): Promise<DailyProgress>;
    stepTypes(opts?: { signal?: AbortSignal }): Promise<{ step_types: QuestStepType[] }>;
    contributeStepType(stepType: DailyStepTypeRequest, opts?: { signal?: AbortSignal }): Promise<QuestStepType>;
    appQuests: {
        define(slug: string, quest: AppQuestRequest, opts?: { signal?: AbortSignal }): Promise<AppQuest>;
        list(opts?: { signal?: AbortSignal }): Promise<{ project_id: string; max: number; quests: AppQuest[] }>;
        retire(slug: string, opts?: { signal?: AbortSignal }): Promise<AppQuest>;
    };
    cardData(opts?: QuestCardOptions): Promise<QuestCardData | null>;
    eventType(projectId: string, name: string): string;
    projectKey(projectId: string): string;
}
export type DailyStepType = QuestStepType;
export type DailyStepTypeRequest = QuestStepTypeRequest;
export type DailyQuest = QuestDaily;
export type DailyProgress = QuestDailyProgress;
export function createQuestClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): QuestClient;
export function eventType(projectId: string, name: string): string;
export function projectKey(projectId: string): string;
