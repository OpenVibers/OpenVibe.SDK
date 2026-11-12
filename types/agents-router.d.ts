// openvibe-sdk/agents/router: route on a Decisions probability with a budget-calibrated threshold.
export interface Outcome { p: number; strong?: boolean; ok?: boolean; usd?: number; }
export function question(step: { text?: string; task?: string }): object;
export function probability(answer: unknown): number | null;
export function route<T>(o: { p: number | null; threshold?: number; small: T; strong: T }): { choice: T; strong: boolean; why: string };
export function calibrate(history: Outcome[], options?: { strongShare?: number }): { threshold: number; samples: number };
export function outcomes(history: Outcome[], shares?: number[]): Array<{ share: number; threshold: number; steps: number; quality: number | null; usd_per_step: number | null }>;
export function chain<T>(step: { text?: string; task?: string }, options?: { pick?: T | null; pin?: T | null; ask?: ((body: object) => Promise<unknown>) | null; threshold?: number; small: T; strong: T }): Promise<{ choice: T; strong: boolean | null; why: string }>;
