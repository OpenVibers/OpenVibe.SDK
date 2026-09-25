import type { OpenVibeClient } from './core';

type Opts = { signal?: AbortSignal };
type Json = Record<string, unknown>;
export interface ChatClient {
    global: {
        history(query?: { limit?: number; after_id?: number }, opts?: Opts): Promise<Json>;
        send(message: string, extra?: { reply_to_id?: number; auto_delete_minutes?: number }, opts?: Opts): Promise<Json>;
        search(query?: { q?: string; user_id?: number; stream_id?: number; limit?: number; offset?: number }, opts?: Opts): Promise<{ messages: Json[]; total?: number }>;
    };
    rooms: {
        list(opts?: Opts): Promise<Json>;
        create(input: { name: string; slug?: string; topic?: string; visibility?: 'public' | 'private' }, opts?: Opts): Promise<Json>;
        get(slug: string, opts?: Opts): Promise<Json | null>;
        update(slug: string, patch: { name?: string; topic?: string; visibility?: 'public' | 'private'; slow_seconds?: number }, opts?: Opts): Promise<Json>;
        messages(slug: string, query?: { before?: number; after?: number; limit?: number }, opts?: Opts): Promise<Json>;
        send(slug: string, message: string, opts?: Opts): Promise<Json>;
        deleteMessage(slug: string, id: number | string, opts?: Opts): Promise<Json>;
        join(slug: string, opts?: Opts): Promise<Json>;
        leave(slug: string, opts?: Opts): Promise<Json>;
        read(slug: string, lastId?: number, opts?: Opts): Promise<Json>;
        members(slug: string, opts?: Opts): Promise<Json>;
        setMember(slug: string, username: string, role: 'member' | 'mod' | 'blocked' | 'none', opts?: Opts): Promise<Json>;
    };
    dms: {
        list(opts?: Opts): Promise<Json>;
        create(userIds: number[], extra?: { name?: string }, opts?: Opts): Promise<Json>;
        get(id: number | string, opts?: Opts): Promise<Json | null>;
        messages(id: number | string, query?: { limit?: number; before?: number }, opts?: Opts): Promise<Json>;
        send(id: number | string, message: string, opts?: Opts): Promise<Json>;
        deleteMessage(id: number | string, msgId: number | string, opts?: Opts): Promise<Json>;
        read(id: number | string, opts?: Opts): Promise<Json>;
        unread(opts?: Opts): Promise<{ unread: number }>;
        blocks(opts?: Opts): Promise<Json>;
        block(userId: number | string, opts?: Opts): Promise<Json>;
        unblock(userId: number | string, opts?: Opts): Promise<Json>;
    };
    exportMine(opts?: Opts): Promise<{ username: string; exported_at: string; total: number; truncated: boolean; messages: Json[] }>;
}
export function createChatClient(client: OpenVibeClient, defaults?: { baseUrl?: string }): ChatClient;
