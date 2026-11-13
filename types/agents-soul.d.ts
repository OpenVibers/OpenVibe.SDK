// openvibe-sdk/agents/soul: who an agent is (agents.soul@1, Contracts 0.424.0), as pure functions.

export type Dial = -2 | -1 | 0 | 1 | 2;
export type SoulOrigin = 'words' | 'memories' | 'gallery' | 'twin' | 'soul-md';
export interface Soul {
    who: string;
    dials?: { warmth?: Dial; play?: Dial; length?: Dial; edge?: Dial };
    quirks?: string[];
    believes?: string[];
    pushback?: string;
    never?: string[];
    notes?: string;
    made_from?: SoulOrigin;
    updated_at?: string;
}
export interface SoulProblem { at: string; why: string }
export interface Face { avatar?: string; glyph?: string; hue?: number; voice?: string | null; tone?: string; greeting?: string }

export function validate(soul: unknown): { ok: boolean; errors: SoulProblem[] };
export function toPrompt(soul: Soul, options?: { name?: string }): string;
export function toSoulMd(soul: Soul, options?: { name?: string }): string;
export function toIdentityMd(identity?: { name?: string; face?: Face }): string;
export function fromSoulMd(text: string): Soul;
export function change(soul: Soul, patch: Partial<{ [K in keyof Soul]: Soul[K] | null }>): { soul: Soul; ok: boolean; errors: SoulProblem[]; words: string };
export function dialWords(name: 'warmth' | 'play' | 'length' | 'edge', value: number): string;
export const DIALS: { readonly warmth: readonly ['dry', 'warm']; readonly play: readonly ['serious', 'playful']; readonly length: readonly ['brief', 'thorough']; readonly edge: readonly ['gentle', 'blunt'] };
export const ORIGINS: readonly SoulOrigin[];
export const LIMITS: { readonly who: number; readonly quirk: number; readonly quirks: number; readonly belief: number; readonly believes: number; readonly pushback: number; readonly rule: number; readonly never: number; readonly notes: number };
export class SoulError extends Error { errors: SoulProblem[] }
