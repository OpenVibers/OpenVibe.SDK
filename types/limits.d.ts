import type { IncomingMessage, ServerResponse } from 'http';

export interface WindowLimits { minute?: number; hour?: number; day?: number }
export type ActorOf = (req: IncomingMessage & Record<string, any>) => string | null;
export interface LimitedEvent { actor: string; name: string; window: 'minute' | 'hour' | 'day'; limit: number }
export type LimitMiddleware = (req: IncomingMessage & Record<string, any>, res: ServerResponse, next: (err?: unknown) => void) => void;
export interface ActorLimiter {
    /** Middleware for one capability or route; its limits replace the defaults window by window. */
    (name: string, limits?: WindowLimits): LimitMiddleware;
    stats(): { allowed: number; limited: number; actors: number };
    reset(): void;
}
export interface LimitStore { hit(name: string, actor: string, windows: [string, number, number][], nowSec: number): Promise<{ limited: false } | { limited: true; window: string; max: number; retry: number }> }
export function createActorLimiter(opts?: { limits?: WindowLimits; actor?: ActorOf; maxActors?: number; now?: () => number; onLimited?: (e: LimitedEvent) => void; store?: LimitStore | null; log?: { warn(msg: string): void } }): ActorLimiter;
/** Shared counters on Valkey: every process and host counts an actor together (null without Valkey). */
export function createValkeyLimitStore(valkey: import('./valkey').Valkey | null): LimitStore | null;
/** req.principal.sub, else the signed-in person (user:<subject>), else ip:<address>. */
export const defaultActor: ActorOf;
export const WINDOWS: { minute: 60; hour: 3600; day: 86400 };
