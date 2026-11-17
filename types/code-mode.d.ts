// openvibe-sdk/code-mode: an agent writes a script that calls its tools in a sandbox (plan §AD.26). Node 22.13 or newer.
export interface Limits { ms?: number; calls?: number; resultBytes?: number; memMb?: number; }
export const LIMITS: Readonly<Required<Limits>>;
export type Answer = { ok: true; value: unknown } | { ok: false; error: string } | unknown;
export function runCode(code: string, o: { tools?: string[]; functions?: string[]; call: (kind: 'tool' | 'function', name: string, payload: unknown) => Promise<Answer> | Answer; limits?: Limits }): Promise<{ ok: boolean; value?: unknown; logs: string[]; calls: number; ms: number; error?: string }>;
export type Definition = { type: 'function'; function: { name: string; description?: string; parameters?: object } } | { name: string; description?: string; inputSchema?: object };
export function signatureOf(def: Definition): string;
export function searchTools(defs: Definition[], query: string, limit?: number): Array<{ name: string; signature: string; description: string }>;
export function typeOf(schema: object): string;
