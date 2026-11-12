// openvibe-sdk/agents/blueprint: make your own agent (agent-blueprints.md), agents.blueprint@1 as pure functions.
import type { Choice, Rung, Tier } from './agents-dispatch';

export type Level = 'ask' | 'auto-edits' | 'approve-for-me' | 'full';
export type PlaceKind = 'none' | 'own' | 'shared' | 'openvibe' | 'sandbox';
export type MemoryScope = 'none' | 'thread' | 'person' | 'team';
export type Who = 'owner' | 'list' | 'followers' | 'anyone';
export type WhenKind = 'manual' | 'chat' | 'feed' | 'comments' | 'git' | 'composer' | 'notifications' | 'mail' | 'schedule' | 'goal' | 'event' | 'webhook' | 'machine';
export type InputType = 'text' | 'number' | 'boolean' | 'choice' | 'channel' | 'room' | 'repository' | 'machine' | 'url';

export interface BlueprintInput { id: string; type: InputType; label: string; help?: string; required?: boolean; default?: string | number | boolean; choices?: string[]; }
export interface Blueprint {
    id: string;
    version: number;
    state: 'draft' | 'published' | 'retired';
    name: string;
    summary: string;
    author: { type: 'user' | 'service'; id: string };
    visibility: 'private' | 'link' | 'public';
    forked_from?: string | null;
    licence?: string;
    tags?: string[];
    inputs?: BlueprintInput[];
    needs?: Array<{ kind: 'machine' | 'key' | 'plan' | 'app' | 'robot'; what: string; why?: string }>;
    face?: { avatar?: string; glyph?: string; hue?: number; voice?: string | null; tone?: string; greeting?: string; elements?: string[] };
    brain?: { pick?: 'auto' | 'size' | 'exact'; size?: Tier; model?: string; rungs?: Rung[]; max_usd_per_m?: number; caps?: string[]; depth?: 'quick' | 'balanced' | 'deep'; advisor?: { size?: 'medium' | 'strong'; consults: number } | null; decisions?: boolean };
    knows: { instructions: string; skills?: string[]; knowledge?: Array<{ kind: 'file' | 'media' | 'wiki' | 'search' | 'repository' | 'url'; ref: string; note?: string }>; examples?: Array<{ ask: string; good: string }> };
    hands?: { tools?: Array<{ tool: string; mode: 'allow' | 'ask'; note?: string }>; search?: boolean };
    places?: { order?: PlaceKind[]; needs?: string[] };
    memory?: { scope: MemoryScope; remember?: string; keep_days?: number | null };
    rules?: { level?: Level; budget?: { run_usd?: number; day_usd?: number; run_seconds?: number; run_steps?: number }; who?: { may: Who } };
    when?: Array<{ kind: WhenKind; rule?: string; where?: { service: string; kind?: string; id?: string }; event?: string; cron?: string; tz?: string }>;
    makes?: { answer?: string[]; schema?: object | null; serve?: { a2a?: boolean; mcp?: boolean; input?: object | null } };
    team?: { play: string; roles: Record<string, string> } | null;
    created_at?: string;
    updated_at?: string;
    published_at?: string | null;
}
export interface Install { agent: string; owner: { type: 'user'; id: string }; blueprint: string; inputs?: Record<string, string | number | boolean>; agreed: string[]; places?: { own?: string[]; shared?: string[] }; updates: 'ask' | 'same-or-less'; pending?: string | null; installed_at?: string; updated_at?: string; }
export interface Problem { at: string; why: string; }
export interface Ask { key: string; part: string; words: string; ask: boolean; }

export class BlueprintError extends Error { errors: Problem[]; }
export function validate(doc: unknown): { ok: boolean; errors: Problem[] };
export function withDefaults(doc: Blueprint): Required<Blueprint>;
export function asks(doc: Blueprint, options?: { describe?: (tool: string) => string | null | undefined }): Ask[];
export function wider(oldDoc: Blueprint, newDoc: Blueprint): Array<{ key: string; words: string }>;
export function unagreed(doc: Blueprint, agreed: string[]): Ask[];
export function fill(doc: Blueprint, inputs?: Record<string, unknown>): Blueprint;
export interface Compiled {
    start: { text: string; title: string; agent?: string; blueprint?: string; play?: string; budget?: { usd?: number; seconds?: number; steps?: number }; depth?: string; context?: object };
    loop: { system: string; tools: Array<{ name: string; mode: 'allow' | 'ask' }>; search: boolean; budget: { usd?: number; seconds?: number; steps?: number }; schema: object | null };
    dispatch: { pin: string | null; rungs: Rung[]; maxPrice: number | null; need: { caps: string[]; tier?: Tier }; advisor: { size?: string; consults: number } | null; decisions: boolean };
    place: { order: PlaceKind[]; needs: string[]; machines: { own?: string[]; shared?: string[] } };
    memory: { scope: MemoryScope; remember: string | null; keep_days: number | null };
    team: { play: string; roles: Record<string, string> } | null;
}
export function compile(doc: Blueprint, options?: { install?: Install | null; inputs?: Record<string, unknown>; text?: string; context?: object; tryIt?: boolean }): Compiled;
export function estimate(doc: Blueprint, choices: Choice[], options?: { turns?: number; tokens?: { tokensIn?: number; tokensOut?: number } }): { usd_per_run: number | null; choice: (Choice & { why: string }) | null; free_on: Rung[]; why: string };
export function ref(doc: { id: string; version: number }): string;
export function parseRef(s: string): { id: string; version: number } | null;
export function toolWords(tool: string): string;
export const FLOOR: string[];
export const LEVELS: Level[];
export const PLACES: PlaceKind[];
export const MEMORY: MemoryScope[];
export const WHO: Who[];
export const WHEN: WhenKind[];
export const INPUT_TYPES: InputType[];
export const TOOL: RegExp;
export const BP_REF: RegExp;
