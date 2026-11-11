import type { OpenVibeClient } from './core';

type Opts = { signal?: AbortSignal };
type Json = Record<string, unknown>;
/** The kinds chat.embed@1 names. */
export type ChatEmbedKind = 'link' | 'video' | 'image' | 'live' | 'picture' | 'design' | 'post' | 'profile' | 'game';
/** chat.embed@1: one address preview under a chat message, the shape every client draws. Plain data; escape it. */
export interface ChatEmbed {
    kind: ChatEmbedKind;
    url: string;
    site_name: string;
    title: string;
    description: string;
    /** An OpenVibe.Media address, or null (another site's picture is never hot-linked). */
    image: string | null;
    width: number;
    height: number;
    /** On OpenVibe's own kinds, the person or channel the thing belongs to. */
    by?: string;
    /** On a Live channel, whether it is broadcasting now. */
    live?: boolean;
}
/** chat.room-insight-result@1: a room's public AI insight (see the contract in openvibe-contracts). */
export interface RoomInsight {
    overview: {
        text: string;
        topics: { label: string; count: number }[];
        people: number;
        messages: number;
        from: string | null;
        to: string | null;
        updated_at: string | null;
    };
    timeline: { at: string; kind: string; title: string; text: string; message_id: number | null }[];
    state: 'ready' | 'quiet' | 'off';
}
/** The typed address previews a message carries (chat.embed@1): [] when it has none. */
export function readEmbeds(message?: { embeds?: unknown } | null): ChatEmbed[];
export type ChatMessageView = 'bubbles' | 'room';
export type ActivityKind = 'mention' | 'reply' | 'reaction' | 'server_invite' | 'friend_accept' | 'role';
export interface ActivityItem {
    id: number;
    kind: ActivityKind;
    actor: { id: number | null; username: string | null; display_name: string | null; avatar_url: string | null };
    where: { kind: 'room' | 'dm' | 'global' | 'server' | 'friends'; label: string; href: string; room?: string | null; server?: string | null; conversation?: number };
    what: { excerpt: string | null; reaction: string | null; role: string | null };
    at: string;
    read: boolean;
}
export interface ChatHistoryPage<T extends { id: number | string } = { id: number | string; [field: string]: unknown }> { messages: T[]; more: boolean; [field: string]: unknown; }
export interface ChatHistoryOptions { limit?: number; before?: number | string | null; signal?: AbortSignal; }
export interface ChatHistoryHelper {
    /** Yield newest-first pages, following each page's oldest message ID until `more` is false. */
    pages<T extends { id: number | string } = { id: number | string; [field: string]: unknown }>(
        readPage: (query: { limit: number; before?: number | string }, opts: { signal?: AbortSignal }) => Promise<ChatHistoryPage<T>>,
        options?: ChatHistoryOptions,
    ): AsyncIterable<ChatHistoryPage<T>>;
    /** Load older pages near the feed top, prepend in display order and preserve the visible anchor. */
    attach<T extends { id: number | string }>(options: {
        feed: HTMLElement;
        status?: HTMLElement | null;
        fetchPage: (before: number) => Promise<ChatHistoryPage<T>>;
        render: (message: T) => HTMLElement;
        hasMore?: boolean;
        threshold?: number;
        scrollToBottom?: boolean;
    }): { load(): Promise<void>; readonly loading: boolean; readonly more: boolean; dispose(): void };
}
export const history: ChatHistoryHelper;
/** One thing a room remembers (server/rooms/memory.js): its words, confidence and where it came from. */
export interface MemoryEntry {
    id: number;
    kind: 'topic' | 'fact' | 'decision' | 'request';
    text: string;
    confidence: number;
    learned_at: string | null;
    learned_by: string;
    updated_at: string | null;
    updated_by: string | null;
    mine: boolean;
    sources: { id: number; author: string; at: string | null; text: string }[];
}
export interface MemoryInput {
    text: string;
    kind?: 'topic' | 'fact' | 'decision' | 'request';
    confidence?: number;
    source_message_ids?: number[];
}
export interface RoomMemory {
    room: { slug: string; name: string };
    entries: MemoryEntry[];
    kinds: string[];
    can_edit: boolean;
    me: string | null;
}
/** chat.person-memory-result@1. Private fields appear only for the person and channel owner. */
export interface PersonMemoryResult {
    username: string;
    level: 'day' | 'week' | 'month';
    channel: string | null;
    opted_out: boolean;
    enabled: boolean;
    entries: {
        level: 'day' | 'week' | 'month'; period_start: string; channel_user_id: number;
        summary: string; topics: string[];
        highlights: { detail: string; stream_id: number | null; at: string | null }[];
        message_count: number; tone?: string; catchphrases?: string[]; people?: string[];
    }[];
}

export interface ChatClient {
    /** The typed address previews a message carries (chat.embed@1): [] when it has none. */
    embeds(message?: { embeds?: unknown } | null): ChatEmbed[];
    history: ChatHistoryHelper;
    people: {
        memory(username: string, query?: { channel?: string; level?: 'day' | 'week' | 'month' }, opts?: Opts): Promise<PersonMemoryResult>;
        forget(username: string, opts?: Opts): Promise<{ deleted: boolean; opted_out: boolean }>;
        preferences(username: string, optedOut: boolean, opts?: Opts): Promise<{ opted_out: boolean }>;
    };
    /** Ask Vibe using Auto, one catalogue model, or two to three models side by side. */
    ask(input: { message: string; models?: string[]; slug?: string; fresh?: boolean; system_prompt?: string; temperature?: number }, opts?: Opts): Promise<{ chat: Json; message: Json }>;
    pick(messageId: number, model: string, opts?: Opts): Promise<{ chat: Json; model: string }>;
    prefer(messageId: number, model: string, opts?: Opts): Promise<{ recorded: boolean; model: string }>;
    global: {
        history(query?: { limit?: number; before?: number; after_id?: number }, opts?: Opts): Promise<Json>;
        send(message: string, extra?: { reply_to_id?: number; auto_delete_minutes?: number }, opts?: Opts): Promise<Json>;
        search(query?: { q?: string; user_id?: number; stream_id?: number; limit?: number; offset?: number }, opts?: Opts): Promise<{ messages: Json[]; total?: number }>;
    };
    rooms: {
        list(opts?: Opts): Promise<Json>;
        create(input: { name: string; slug?: string; topic?: string; visibility?: 'public' | 'private' }, opts?: Opts): Promise<Json>;
        get(slug: string, opts?: Opts): Promise<Json | null>;
        insight(id: string, opts?: Opts): Promise<RoomInsight | null>;
        memory(id: string, opts?: Opts): Promise<RoomMemory>;
        addMemory(id: string, input: MemoryInput, opts?: Opts): Promise<{ entry: MemoryEntry }>;
        correctMemory(id: string, entryId: number | string, patch: Partial<MemoryInput>, opts?: Opts): Promise<{ entry: MemoryEntry }>;
        removeMemory(id: string, entryId: number | string, opts?: Opts): Promise<{ removed: boolean }>;
        forgetMyMemory(id: string, opts?: Opts): Promise<{ removed: number }>;
        update(slug: string, patch: { name?: string; topic?: string; visibility?: 'public' | 'private'; slow_seconds?: number }, opts?: Opts): Promise<Json>;
        messages(slug: string, query?: { before?: number; after?: number; limit?: number }, opts?: Opts): Promise<Json>;
        send(slug: string, message: string, extra?: { reply_to_id?: number }, opts?: Opts): Promise<Json>;
        react(slug: string, messageId: number | string, reaction: 'thumbsup' | 'thumbsdown' | 'heart' | 'laugh' | 'surprised' | 'sad', opts?: Opts): Promise<{ ok: boolean; reaction: string | null }>;
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
        send(id: number | string, message: string, extra?: { reply_to_id?: number }, opts?: Opts): Promise<Json>;
        deleteMessage(id: number | string, msgId: number | string, opts?: Opts): Promise<Json>;
        read(id: number | string, opts?: Opts): Promise<Json>;
        unread(opts?: Opts): Promise<{ unread: number }>;
        blocks(opts?: Opts): Promise<Json>;
        block(userId: number | string, opts?: Opts): Promise<Json>;
        unblock(userId: number | string, opts?: Opts): Promise<Json>;
        viewPreference(id: number | string, opts?: Opts): Promise<{ view: ChatMessageView; conversation_id: number }>;
        setViewPreference(id: number | string, view: ChatMessageView, opts?: Opts): Promise<{ view: ChatMessageView; conversation_id: number }>;
    };
    exportMine(opts?: Opts): Promise<{ username: string; exported_at: string; total: number; truncated: boolean; messages: Json[] }>;
    activity: {
        list(query?: { limit?: number; before?: number; kind?: string }, opts?: Opts): Promise<{ items: ActivityItem[]; next_before: number | null; unread: number }>;
        unread(opts?: Opts): Promise<{ unread: number }>;
        readOne(id: number | string, opts?: Opts): Promise<{ ok: boolean; read: number; unread: number }>;
        read(ids?: number[] | null, opts?: Opts): Promise<{ ok: boolean; read: number; unread: number }>;
    };
    vibe: {
        list(opts?: Opts): Promise<{ chats: Json[]; allowance?: Json }>;
        conversations(opts?: Opts): Promise<{ conversations: Array<{ slug: string; name: string; last_message_at: string; created_at: string; last_line: string | null; last_answer_at: string | null; site: string | null }>; count: number }>;
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
        assign(id: string, convId: string, assigneeId: number | null, opts?: Opts): Promise<{ conversation: Json }>;
        translateMessage(id: string, convId: string, messageId: number | string, to: string, opts?: Opts): Promise<{ text: string; lang: string; cached: boolean }>;
        translateDraft(id: string, text: string, to: string, opts?: Opts): Promise<{ text: string; lang: string }>;
        read(id: string, convId: string, opts?: Opts): Promise<Json>;
        identity(id: string, action: 'on' | 'rotate' | 'off', opts?: Opts): Promise<{ identity_secret: string | null }>;
        replies(id: string, opts?: Opts): Promise<{ replies: { id: number; shortcut: string; body: string }[] }>;
        saveReply(id: string, shortcut: string, body: string, opts?: Opts): Promise<{ replies: { id: number; shortcut: string; body: string }[] }>;
        deleteReply(id: string, replyId: number | string, opts?: Opts): Promise<{ replies: { id: number; shortcut: string; body: string }[] }>;
        webhooks(id: string, opts?: Opts): Promise<{ webhooks: Json[] }>;
        addWebhook(id: string, url: string, opts?: Opts): Promise<{ webhook: Json; secret: string | null }>;
        testWebhook(id: string, hookId: number | string, opts?: Opts): Promise<{ ok: boolean; status: number | null; error: string | null }>;
        removeWebhook(id: string, hookId: number | string, opts?: Opts): Promise<void | Json>;
        actions(id: string, opts?: Opts): Promise<{ actions: InboxAction[] }>;
        addAction(id: string, input: InboxActionInput, opts?: Opts): Promise<{ action: InboxAction; secret: string }>;
        testAction(id: string, actionId: number | string, args?: Record<string, string>, opts?: Opts): Promise<{ ok: boolean; status: number | null; error: string | null; result: string | null }>;
        removeAction(id: string, actionId: number | string, opts?: Opts): Promise<void | Json>;
    };
    support: {
        list(query?: { limit?: number }, opts?: Opts): Promise<{ conversations: Json[] }>;
        messages(convId: string, query?: { after?: number }, opts?: Opts): Promise<{ conversation: Json; messages: InboxMessage[] } | null>;
        send(convId: string, message: string, opts?: Opts): Promise<{ conversation: Json; message: InboxMessage }>;
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
export interface InboxInput {
    name?: string; greeting?: string; color?: string; ai_enabled?: boolean; ai_instructions?: string; knowledge_urls?: string[] | string; allowed_origins?: string[] | string;
    /** false: a site assistant, only Vibe answers */
    handoff?: boolean;
    /** When the inbox's people answer; null: always */
    hours?: { tz: string; days: number[]; start: string; end: string } | null;
    /** round_robin: a visitor waiting goes to the next of the people */
    route?: 'none' | 'round_robin';
}
export interface InboxActionInput { name: string; description: string; url: string; params?: { name: string; description?: string }[] | string }
export interface InboxAction { id: number; name: string; description: string; url: string; params: { name: string; description: string }[]; last_status: number | null; last_error: string | null; last_at: string | null }
export interface InboxMessage { id: number; author: 'visitor' | 'agent' | 'ai' | 'system'; author_name?: string | null; body: string; created_at: string; /** a visitor's message written signed in: its Pics links show as pictures */ account?: true }
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
    visit(opts?: Opts): Promise<{ token: string; verified?: boolean; account?: { name: string } | null; inbox: Json; conversation: Json | null; messages: InboxMessage[] }>;
    send(message: string, extra?: { page_url?: string; name?: string }, opts?: Opts): Promise<{ conversation: Json; message: InboxMessage }>;
    messages(query?: { after?: number }, opts?: Opts): Promise<{ conversation: Json | null; messages: InboxMessage[] }>;
    handoff(opts?: Opts): Promise<{ conversation: Json }>;
    rate(rating: 1 | -1, extra?: { comment?: string; conversation?: string }, opts?: Opts): Promise<{ conversation: Json }>;
    sendPicture(picture: Blob | ArrayBuffer | Uint8Array, extra?: { caption?: string; contentType?: string }, opts?: Opts): Promise<{ conversation: Json; message: InboxMessage; picture: { slug: string; direct: string; page: string } }>;
}
export interface FeedPublisher {
    hello(input?: { sessionKey?: string; publisher?: Json }, opts?: Opts): Promise<{ sessionKey: string; publisher: Json }>;
    publish(events: FeedEvent | FeedEvent[], opts?: Opts): Promise<{ events: { eventId: string; delivered: boolean }[] }>;
    claudeCode(hook: Json, opts?: Opts): Promise<Json>;
}
export function createChatClient(client: OpenVibeClient, defaults?: { baseUrl?: string }): ChatClient;
export function createInboxVisitor(client: OpenVibeClient, options: { inbox: string; token?: string | null; user?: { id: string; name?: string; email?: string; hash: string } | null; account?: string | null; baseUrl?: string }): InboxVisitor;
export function createFeedPublisher(client: OpenVibeClient, options: { feed: string; key: string; baseUrl?: string }): FeedPublisher;
