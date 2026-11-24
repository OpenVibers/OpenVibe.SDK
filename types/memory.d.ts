// openvibe-sdk/memory: a person's memory in OpenVibe.AI, for services granted ai.memory.read / ai.memory.write.
export type Kind = 'preference' | 'fact' | 'project_rule' | 'procedure' | 'decision' | 'lesson';
export interface NoteIn { text: string; kind?: Kind; scope?: string; confidence?: number; /** the person said it, in their own words (the store keeps it active) */ person_said?: boolean }
export interface Note { id?: string; text: string; kind?: Kind; scope?: string; [k: string]: unknown }
export interface CallOptions { signal?: AbortSignal }
export interface MemoryClient {
    remember(person: string, items: NoteIn | string | Array<NoteIn | string>, o?: CallOptions & { scope?: string; idempotencyKey?: string }): Promise<{ items?: Note[]; [k: string]: unknown }>;
    recall(person: string, q: string, o?: CallOptions & { scopes?: string[] }): Promise<{ items: Note[]; count: number }>;
    profile(person: string, o?: CallOptions & { scope?: string }): Promise<{ profile: unknown }>;
}
export function createMemoryClient(client: { json(opts: Record<string, unknown>): Promise<any> }, defaults?: { baseUrl?: string }): MemoryClient;
export const KINDS: readonly Kind[];
export const MAX_BATCH: number;
export const MEMORY_PAGE: string;
