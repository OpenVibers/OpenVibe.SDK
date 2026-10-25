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
    vibe: {
        list(opts?: Opts): Promise<{ chats: Json[]; allowance?: Json }>;
        start(message: string, opts?: Opts): Promise<{ room: Json; message: Json }>;
        rename(slug: string, name: string, opts?: Opts): Promise<Json>;
        remove(slug: string, opts?: Opts): Promise<Json>;
    };
    inboxes: {
        list(opts?: Opts): Promise<{ inboxes: Json[] }>;
        create(input: InboxInput & { name: string }, opts?: Opts): Promise<{ inbox: Json; embed: { script: string; panel: string } }>;
        get(id: string, opts?: Opts): Promise<{ inbox: Json; role: 'owner' | 'agent'; members: Json[]; embed: { script: string; panel: string } } | null>;
        update(id: string, patch: InboxInput, opts?: Opts): Promise<Json>;
        remove(id: string, opts?: Opts): Promise<Json>;
        addMember(id: string, username: string, opts?: Opts): Promise<Json>;
        removeMember(id: string, userId: number | string, opts?: Opts): Promise<Json>;
        conversations(id: string, query?: { status?: 'active' | ConversationStatus }, opts?: Opts): Promise<{ conversations: Json[] }>;
        messages(id: string, convId: string, query?: { after?: number }, opts?: Opts): Promise<{ conversation: Json; messages: InboxMessage[] }>;
        reply(id: string, convId: string, message: string, opts?: Opts): Promise<{ message: InboxMessage }>;
        setStatus(id: string, convId: string, status: 'open' | 'resolved' | 'bot', opts?: Opts): Promise<{ conversation: Json }>;
        read(id: string, convId: string, opts?: Opts): Promise<Json>;
    };
    feeds: {
        mine(opts?: Opts): Promise<{ feeds: Json[] }>;
        create(input?: FeedInput, opts?: Opts): Promise<{ feed: Json; key: string }>;
        update(id: string, patch: FeedInput, opts?: Opts): Promise<{ feed: Json }>;
        rotateKey(id: string, opts?: Opts): Promise<{ key: string }>;
        remove(id: string, opts?: Opts): Promise<void | Json>;
        view(id: string, query?: { limit?: number }, opts?: Opts): Promise<{ feed: Json; publisher: Json | null; events: FeedEvent[] } | null>;
        onLive(where: { slot: number | number[] } | { channel: string }, opts?: Opts): Promise<{ feeds: Json[] }>;
    };
}
export type ConversationStatus = 'bot' | 'waiting' | 'open' | 'resolved';
export interface InboxInput { name?: string; greeting?: string; color?: string; ai_enabled?: boolean; ai_instructions?: string; knowledge_urls?: string[] | string; allowed_origins?: string[] | string }
export interface InboxMessage { id: number; author: 'visitor' | 'agent' | 'ai' | 'system'; author_name?: string | null; body: string; created_at: string }
export interface FeedInput { title?: string; room?: string | number | null; slot?: number | null; settings?: Record<string, number | string | boolean> }
export type FeedEventType = 'session.status' | 'prompt' | 'response' | 'thinking' | 'tool.call' | 'file.change' | 'file.save';
export interface FeedEvent {
    eventType: FeedEventType;
    eventId?: string;
    sessionKey?: string;
    sequence?: number;
    occurredAt?: string;
    summary?: string;
    text?: string;
    prompt?: { text: string }; response?: { text: string }; thinking?: { text: string };
    tool?: { name: string; phase?: string; argumentsPreview?: string | null; resultPreview?: string | null };
    file?: { name?: string; relativePath?: string | null; operation?: string; changeCount?: number; snippet?: string | null };
    publisher?: Json; metadata?: Json; source?: Json;
}
export interface InboxVisitor {
    readonly token: string | null;
    config(opts?: Opts): Promise<{ inbox: { id: string; name: string; greeting: string; color: string; ai: boolean; people: boolean } }>;
    visit(opts?: Opts): Promise<{ token: string; verified?: boolean; inbox: Json; conversation: Json | null; messages: InboxMessage[] }>;
    send(message: string, extra?: { page_url?: string; name?: string }, opts?: Opts): Promise<{ conversation: Json; message: InboxMessage }>;
    messages(query?: { after?: number }, opts?: Opts): Promise<{ conversation: Json | null; messages: InboxMessage[] }>;
    handoff(opts?: Opts): Promise<{ conversation: Json }>;
    rate(rating: 1 | -1, extra?: { comment?: string; conversation?: string }, opts?: Opts): Promise<{ conversation: Json }>;
}
export interface FeedPublisher {
    hello(input?: { sessionKey?: string; publisher?: Json }, opts?: Opts): Promise<{ sessionKey: string; publisher: Json }>;
    publish(events: FeedEvent | FeedEvent[], opts?: Opts): Promise<{ events: { eventId: string; delivered: boolean }[] }>;
    claudeCode(hook: Json, opts?: Opts): Promise<Json>;
}
export function createChatClient(client: OpenVibeClient, defaults?: { baseUrl?: string }): ChatClient;
export function createInboxVisitor(client: OpenVibeClient, options: { inbox: string; token?: string | null; user?: { id: string; name?: string; email?: string; hash: string } | null; baseUrl?: string }): InboxVisitor;
export function createFeedPublisher(client: OpenVibeClient, options: { feed: string; key: string; baseUrl?: string }): FeedPublisher;
