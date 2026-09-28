/** openvibe-sdk/pubsub — fan-out between processes on Valkey, in-process without it (ADR-035). Not durable. */
import type { Valkey } from './valkey';
export interface PubSub {
    publish(channel: string, message: unknown): Promise<number>;
    /** Resolves to an unsubscribe function. */
    subscribe(channel: string, handler: (message: any) => void): Promise<() => Promise<void>>;
    close(): Promise<void>;
}
export function createPubSub(opts?: { valkey?: Valkey | null; log?: { warn(msg: string): void } }): PubSub;
