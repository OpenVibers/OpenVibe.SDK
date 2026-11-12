// openvibe-sdk/agents/metrics: what a run measured (agents.run@1 1.4.0 metrics).
export type Exit = 'done' | 'limits' | 'timeout' | 'format_error' | 'refused' | 'tool_error' | 'stopped' | 'error';
export interface Evidence { kind: 'test' | 'schema' | 'grader' | 'person' | 'decision'; passed: boolean; detail?: string; probability?: number; }
export interface Metrics { charged_usd: number | null; estimated_usd: number | null; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number; latency_ms: number; steps: number; exit?: Exit; evidence: Evidence[]; }
export interface Usage { tokens_in?: number; tokens_out?: number; cache_read?: number; cache_write?: number; charged_usd?: number | null; estimated_usd?: number | null; }
export interface Recorder { call(u: Usage): Recorder; step(): Recorder; evidence(e: Evidence): Recorder; end(exit?: Exit | string): Metrics; snapshot(): Metrics; }
export function createRecorder(options?: { now?: () => number }): Recorder;
export function passAtK(results: boolean[], k: number): number | null;
export function passHatK(results: boolean[], k: number): number | null;
export function flakeRate(cases: boolean[][]): number | null;
export const EXITS: Exit[];
export const EVIDENCE: Evidence['kind'][];
