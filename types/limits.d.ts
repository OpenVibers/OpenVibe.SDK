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
export function createActorLimiter(opts?: { limits?: WindowLimits; actor?: ActorOf; maxActors?: number; now?: () => number; onLimited?: (e: LimitedEvent) => void }): ActorLimiter;
/** req.principal.sub, else the signed-in person (user:<subject>), else ip:<address>. */
export const defaultActor: ActorOf;
export const WINDOWS: { minute: 60; hour: 3600; day: 86400 };
