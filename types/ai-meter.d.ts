// openvibe-sdk/ai-meter: every product meters its AI calls the same way (ai.call-report@1).
export type Operation = 'chat' | 'completion' | 'embedding' | 'image' | 'image_edit' | 'speech' | 'transcription' | 'translation' | 'rerank' | 'moderation' | 'decision' | 'realtime' | 'batch' | 'tool' | 'other';
export type Place = 'provider' | 'machine' | 'community' | 'plan' | 'host';
export interface Tokens { input: number; output: number; reasoning: number; cache_read: number; cache_write: number; ollama?: { eval_ms: number | null } }
export interface CallRecord { system: string; provider: string; model: string; run_id?: string; turn_id?: string; surface: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'cached'; at: string; input: number; output: number; reasoning: number; cache_read: number; cache_write: number; latency_ms: number; ttft_ms: number | null; attempts: number; streamed: boolean; tps: number | null; [k: string]: unknown }
export interface Call { queued(ms: number): Call; firstToken(): Call; tool(count?: number): Call; end(e?: { usage?: unknown; outcome?: string; fallbacks?: number; cache_hit?: boolean; error_class?: string; task_ms?: number; charged_usd?: number; images?: number; audio_seconds?: number }): CallRecord; }
export function startCall(o: { system: string; provider: string; model: string; run_id?: string; turn_id?: string; operation?: Operation; task?: string; task_id?: string; harness?: string; place?: Place; surface?: string; streamed?: boolean; region?: string; subject?: unknown; attribution?: string; paid_by?: string; effort?: string; now?: () => number }): Call;
export function normalize(usage: unknown): Tokens;
export function tokensPerSecond(output: number, ms: number): number | null;
export function createMeterClient(o: { aiUrl: string; tokenClient?: { getToken(ctx?: { audience?: string }): Promise<string>; invalidate?(): void } | null; fetch?: typeof fetch; batch?: number; flushMs?: number; maxQueue?: number; log?: { warn?(m: string): void }; audience?: string }): { record(rec: CallRecord): boolean; flush(): Promise<void>; close(): Promise<void>; stats(): { sent: number; dropped: number; rejected: number; retried: number; queued: number } };
export const OPERATIONS: Operation[];
export const PLACES: Place[];
export const OUTCOMES: string[];
