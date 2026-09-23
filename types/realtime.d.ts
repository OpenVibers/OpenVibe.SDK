import type { OpenVibeClient, EventEnvelope, FetchLike, TokenContext } from './core';

export interface RealtimeGap { reason: 'retention' | 'replay_limit' | 'cursor_ahead' | string; from_seq: number; to_seq: number; latest_seq?: number; }
export interface SubscribeOptions {
    client?: OpenVibeClient;
    /** Events origin or the full …/realtime/stream URL; default from the client's registry, else https://events.openvibe.network */
    url?: string;
    baseUrl?: string;
    /** Resume after this seq (e.g. saved before a reload). */
    lastEventId?: number | string | null;
    onGap?: (gap: RealtimeGap) => void;
    onOpen?: () => void;
    onError?: (err: Error) => void;
    /** A Bearer token forces the fetch transport (EventSource cannot send headers). */
    token?: string;
    getToken?: (ctx: TokenContext) => Promise<string | null | undefined> | string | null | undefined;
    withCredentials?: boolean;
    transport?: 'auto' | 'eventsource' | 'fetch';
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    fetch?: FetchLike;
    EventSource?: any;
}
export interface RealtimeSubscription {
    close(): void;
    readonly lastEventId: number | null;
    readonly transport: 'eventsource' | 'fetch';
    readonly connected: boolean;
    readonly closed: boolean;
    readonly done: Promise<void>;
}
export declare function subscribe(topics: string | string[], onEvent: (event: EventEnvelope, meta: { seq: number }) => void, opts?: SubscribeOptions): RealtimeSubscription;
export declare function createRealtimeClient(client: OpenVibeClient, defaults?: Omit<SubscribeOptions, 'client'>): { subscribe(topics: string | string[], onEvent: (event: EventEnvelope, meta: { seq: number }) => void, opts?: SubscribeOptions): RealtimeSubscription };
export interface SSEMessage { event: string; data: string; id: string | undefined; }
/** WHATWG event-stream parser over a fetch body (or any async iterable of chunks). */
export declare function parseSSE(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>, opts?: { onRetry?: (ms: number) => void }): AsyncGenerator<SSEMessage, void, unknown>;
export declare const DEFAULT_ORIGIN: string;
