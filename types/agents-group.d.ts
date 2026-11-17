// openvibe-sdk/agents/group: a conversation of people and agents in one thread (plan §AD.19).
export interface Member { id: string; kind: 'person' | 'agent'; name?: string; handle?: string; lead?: boolean; coder?: boolean; }
export interface Message { from: string; fromKind?: 'person' | 'agent'; text?: string; usd?: number; }
export interface Policy { maxAgentTurns?: number; budgetUsd?: number; transcriptLast?: number; }
export const POLICY: Readonly<Required<Policy>>;
export const CODE_WORDS: RegExp;
export function mentions(text: string, members: Member[]): string[];
export function next(o: { message: Message; members: Member[]; history?: Message[]; policy?: Policy }): { speakers: string[]; why: string };
export function limits(o: { history?: Message[]; policy?: Policy }): { ok: boolean; turns: number; usd: number; why: string };
export function isDone(text: string): boolean;
export function round(history: Message[]): Message[];
export function transcript(o: { history?: Message[]; member: string; members: Member[]; files?: Array<{ name?: string; url?: string }>; last?: number }): string;
