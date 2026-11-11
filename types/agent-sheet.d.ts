import type { OpenVibeClient } from './core';
export interface AgentSheet {
    agent: { id: string; name: string; face: string | null; state: string; [key: string]: unknown };
    now: Record<string, unknown> | null;
    work: Array<Record<string, unknown>>;
    asks: Array<Record<string, unknown>>;
    asks_empty: string | null;
    computer: Record<string, unknown> | null;
    schedules: Array<Record<string, unknown>>;
    memory: Array<Record<string, unknown>>;
    activity: Array<Record<string, unknown>>;
}
export interface AgentSheetClient {
    sheet(agentId: string, options?: { signal?: AbortSignal }): Promise<AgentSheet>;
    codesSheet(harnessId: string, options?: { signal?: AbortSignal }): Promise<AgentSheet>;
    pause(agentId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
    resume(agentId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
    memory: {
        add(agentId: string, text: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
        update(agentId: string, memoryId: string, text: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
        remove(agentId: string, memoryId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    };
}
export function createAgentSheetClient(client: OpenVibeClient, options?: { baseUrl?: string }): AgentSheetClient;
