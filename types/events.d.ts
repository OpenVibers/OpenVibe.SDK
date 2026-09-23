import type { OpenVibeClient, EventEnvelope } from './core';

/** What a producer passes: event_id, timestamp, source, version, payload and trace_id are filled in. */
export type EventInput = Omit<EventEnvelope, 'event_id' | 'timestamp' | 'source' | 'version' | 'payload'> & Partial<Pick<EventEnvelope, 'event_id' | 'timestamp' | 'source' | 'version' | 'payload'>>;
export interface PublishResult { event_id: string; seq: number; duplicate: boolean; }
export interface StoredEvent { seq: number; event: EventEnvelope; }
export interface Gap { from_seq: number; to_seq: number; reason?: string; latest_seq?: number; }
export interface EventsPage { events: StoredEvent[]; next_after_seq: number; latest_seq: number; gap?: Gap; }
export interface Subscription {
    id: string;
    consumer: string;
    topic_pattern: string;
    endpoint: string;
    enabled: boolean;
    retry_policy: { max_attempts?: number; backoff_ms?: number[] } | null;
    /** Only in the create response. */
    secret?: string;
    [field: string]: unknown;
}
export interface CreateSubscription { topicPattern: string; endpoint: string; secret?: string; retryPolicy?: { max_attempts?: number; backoff_ms?: number[] }; }

export interface EventsClient {
    prepare(envelope: EventInput, opts?: { traceId?: string; now?: number }): EventEnvelope;
    publish(envelope: EventInput, opts?: { traceparent?: string }): Promise<PublishResult>;
    publish(envelopes: EventInput[], opts?: { traceparent?: string }): Promise<{ results: PublishResult[] }>;
    pull(opts?: { topic?: string | string[]; afterSeq?: number; limit?: number }): Promise<EventsPage>;
    iterate(opts?: { topic?: string | string[]; afterSeq?: number; limit?: number; onGap?: (gap: Gap) => void | Promise<void>; onPage?: (page: EventsPage) => void | Promise<void> }): AsyncGenerator<StoredEvent, void, unknown>;
    get(eventId: string): Promise<StoredEvent | null>;
    getCheckpoint(topic: string): Promise<{ consumer: string; topic: string; cursor: number; updated_at: string | null }>;
    setCheckpoint(topic: string, cursor: number): Promise<{ consumer: string; topic: string; cursor: number }>;
    subscriptions: {
        create(input: CreateSubscription): Promise<Subscription>;
        list(): Promise<Subscription[]>;
        get(id: string): Promise<Subscription | null>;
        disable(id: string): Promise<Subscription>;
        enable(id: string): Promise<Subscription>;
    };
    subscribe(input: CreateSubscription): Promise<Subscription>;
    deliveries(opts?: { status?: 'pending' | 'delivered' | 'failed' | 'dead'; subscriptionId?: string; afterSeq?: number; limit?: number }): Promise<{ deliveries: Array<Record<string, unknown>>; counts: Record<string, number> }>;
    replay(opts: { subscriptionId: string; fromSeq?: number; eventIds?: string[] }): Promise<{ subscription_id: string; queued: number }>;
}
export declare function createEventsClient(client: OpenVibeClient, opts?: { source?: string; baseUrl?: string }): EventsClient;

type RawBody = string | Uint8Array | ArrayBufferView;
export declare function signDelivery(rawBody: RawBody, secret: string): string;
export declare function verifyDelivery(rawBody: RawBody, signatureHeader: string | undefined | null, secret: string): boolean;
export declare function parseDelivery(rawBody: RawBody, headers: Record<string, any> | Headers, secret: string): { event: EventEnvelope; seq: number; subscriptionId: string | null; attempt: number } | null;

/** The subset of a better-sqlite3 Database the outbox and inbox use. */
export interface SqliteDatabase {
    prepare(sql: string): any;
    exec(sql: string): any;
    transaction<F extends (...args: any[]) => any>(fn: F): F;
    readonly inTransaction: boolean;
}
export interface FlushStats { sent: number; failed: number; rejected: number; }
export interface Outbox {
    ensureSchema(): void;
    /** Inside the caller's transaction; returns the complete envelope. */
    enqueue(envelope: EventInput, opts?: { traceparent?: string }): EventEnvelope;
    flush(): Promise<FlushStats>;
    start(): void;
    stop(): Promise<unknown>;
    kick(): void;
    pending(): number;
    rejected(): number;
    prune(olderThanMs?: number): number;
}
export declare function createOutbox(db: SqliteDatabase, opts: {
    events: Pick<EventsClient, 'publish' | 'prepare'>;
    table?: string; batchSize?: number; intervalMs?: number; backoffMs?: number[];
    now?: () => number; onError?: (err: unknown, row?: unknown) => void; allowOutsideTransaction?: boolean;
}): Outbox;
export interface Inbox {
    ensureSchema(): void;
    once<T>(consumer: string, eventId: string, fn: () => T): { duplicate: true } | { duplicate: false; result: T };
    seen(consumer: string, eventId: string): boolean;
}
export declare function createInbox(db: SqliteDatabase, opts?: { table?: string; now?: () => number }): Inbox;
