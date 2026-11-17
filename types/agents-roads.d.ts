// openvibe-sdk/agents/roads: which of a person's own resources runs their next turn (plan §AD.17).
export type Mode = 'auto' | 'agent' | 'chat' | 'code';
export type Road = 'choice' | 'free' | 'key' | 'computer' | 'none' | 'code';
export interface Allowance { unlimited?: boolean; tokens?: number | null; left?: number | null; resets_at?: string | null; }
export interface Rung { road: Road; open: boolean; why: string; }
export interface RoadResult {
    road: Road; mode: Mode; need: number; why: string; ladder: Rung[];
    provider?: string; model?: string | null; machine?: { id: string | number | null; name: string | null };
    left?: number | null; known?: boolean; resets_at?: string | null; chat_only?: boolean; value?: unknown;
}
export interface Facts {
    mode?: Mode | string; need?: number; allowance?: Allowance | null; choice?: { provider: string; model?: string | null } | null;
    keys?: Array<{ provider: string; ok?: boolean; status?: string; apps?: string[] }>;
    machines?: Array<{ id?: string | number; name?: string; online?: boolean; disabled?: boolean }>;
    app?: string;
}
type Lazy<T> = T | null | undefined | (() => T | null | undefined | Promise<T | null | undefined>);
export interface Rungs {
    mode?: Mode | string; need?: number;
    choice?: Lazy<{ provider: string; model?: string | null }>;
    allowance?: Lazy<Allowance>;
    key?: Lazy<{ provider: string; [k: string]: unknown }>;
    computer?: Lazy<unknown>;
}
export const ROADS: readonly ['choice', 'free', 'key', 'computer'];
export const MODES: readonly Mode[];
export const TURN_TOKENS: number;
export function needFor(mode: Mode | string, options?: { turnTokens?: number }): number;
export function fits(allowance: Allowance | null | undefined, need: number): { ok: boolean; known: boolean; left: number | null; why: string };
export function pick(facts?: Facts): RoadResult;
export function walk(rungs?: Rungs): Promise<RoadResult>;
export function say(result: RoadResult | null | undefined): string;
