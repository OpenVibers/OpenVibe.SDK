// openvibe-sdk/agents/api: the Run API from a product's own store (Contracts docs/agents-runs.md).
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RunOwner { type: string; id: string; }
export interface RunStore {
    list?(q: { owner: RunOwner; kind: string | null; status: string | null; q: string | null; limit: number; cursor: string | null }): Promise<{ runs: object[]; next?: string | null }>;
    get?(q: { owner: RunOwner; id: string }): Promise<object | null>;
    steps?(q: { owner: RunOwner; id: string; after: number; limit: number }): Promise<{ steps: object[]; next?: string | null } | null>;
    start?(q: { owner: RunOwner; input: { text: string; [key: string]: unknown }; idempotencyKey: string | null }): Promise<object>;
    say?(q: { owner: RunOwner; id: string; text: string; attachments: unknown[] }): Promise<object>;
    stop?(q: { owner: RunOwner; id: string; reason: string | null }): Promise<object>;
    answer?(q: { owner: RunOwner; id: string; approval: string; answer: unknown }): Promise<unknown>;
    follow?(q: { owner: RunOwner; id: string; after: number; signal: AbortSignal; emit(event: string, data: object, id?: number): void }): Promise<void>;
}
export interface RunApiOptions {
    store: RunStore;
    subject(req: IncomingMessage): Promise<{ type?: string; id: string } | null> | { type?: string; id: string } | null;
    product: string;
    prefix?: string;
    pollMs?: number;
    streamMs?: number;
    /** Intake's own hook: a mandate for a start it took in (agents.run-start@1's MANDATE); callers never set one. */
    intake?(req: IncomingMessage, input: object): Promise<object | null> | object | null;
}
export function createRunApi(options: RunApiOptions): { handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void>; KINDS: string[]; STATUSES: string[] };
export function startInput(body: object): { text: string; [key: string]: unknown };
export const KINDS: string[];
export const STATUSES: string[];
