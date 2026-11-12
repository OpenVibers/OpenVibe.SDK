// openvibe-sdk/agents/dispatch: the Dispatcher (agent-engine.md §3), pure functions over a person's choices.

export type Rung = 'machine' | 'plan' | 'key' | 'allowance' | 'credits';
export type Tier = 'small' | 'medium' | 'strong';
export interface Choice {
    id: string;
    name?: string;
    rung?: Rung;
    family?: string;
    tier?: Tier;
    caps?: string[];
    context?: number;
    speed?: number;
    price?: { in?: number; out?: number };
    available?: boolean;
}
export interface Need { caps?: string[]; context?: number; speed?: number; tier?: Tier; }
export interface LadderOptions { need?: Need; pin?: string | null; avoid?: string[]; budgetLeft?: number | null; tokens?: { tokensIn?: number; tokensOut?: number }; }
export type Ladder = Array<Choice & { why: string }> & { skipped: Array<{ choice: Choice; why: string; pinned?: boolean }> };
export function ladder(choices: Choice[], options?: LadderOptions): Ladder;
export function pick(choices: Choice[], options?: LadderOptions): { choice: (Choice & { why: string }) | null; why: string; passedOver: { id: string; why: string } | null; skipped: Ladder['skipped'] };
export interface Evidence { kind: 'test' | 'schema' | 'tool' | 'grader' | 'unsure'; detail?: string; }
export function escalate(current: Choice, evidence: Evidence | null, choices: Choice[], options?: { need?: Need; tried?: string[]; budgetLeft?: number | null }): { choice: Choice & { why: string }; why: string } | null;
export interface Harness { id: string; caps?: string[]; plan?: string; }
export function harnessFor(task: { needs?: string[] }, harnesses: Harness[], options?: { plans?: string[] }): { harness: Harness; why: string } | null;
export interface Machine { id: string; name?: string; online?: boolean; allows?: string[]; repos?: string[]; }
export interface Where { kind: 'openvibe' | 'machine' | 'runner' | 'this-computer'; id?: string; name?: string; }
export function placeFor(run: { target?: unknown; needs?: string[]; robot?: string; untrusted?: boolean; heavy?: boolean }, options?: { machines?: Machine[]; cloud?: boolean }): { where: Where; why: string } | null;
export function estimate(choice: Choice, tokens?: { tokensIn?: number; tokensOut?: number }): number;
export function slice(parent: { usd?: number; tokens?: number; seconds?: number; steps?: number } | null, share: number): { usd?: number; tokens?: number; seconds?: number; steps?: number };
export function cannot(choice: Choice, need?: Need): string | null;
export const RUNGS: Rung[];
export const TIERS: Tier[];
export const EVIDENCE: Array<Evidence['kind']>;
