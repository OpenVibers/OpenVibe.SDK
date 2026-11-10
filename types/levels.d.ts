import type { OpenVibeClient } from './core';
export interface Level { level: number; xp: number; into: number; span: number; next_at: number; rank: number | null; recent: Array<{ name: string; at: string; amount: number }>; }
export interface Entry { subject: string; username: string; level: number; xp: number; rank: number; }
export interface Period { top: Entry[]; me: Entry | null; around: Entry[]; }
export interface Award { subject: string; reason: 'quest.completed' | 'coins.earned' | 'video.published' | 'stream.watched'; amount: number; idempotency_key: string; }
export function createLevelsClient(client: OpenVibeClient, options?: { baseUrl?: string }): {
 get(username: string, options?: { signal?: AbortSignal }): Promise<Level>;
 batch(subjects: string[], options?: { signal?: AbortSignal }): Promise<{ levels: Record<string, number> }>;
 board(options?: { signal?: AbortSignal }): Promise<{ all_time: Period; week: Period }>;
 award(body: Award, options?: { signal?: AbortSignal }): Promise<Level>;
};
