export type Strategy = 'automatic' | 'cheapest' | 'fastest' | 'private' | 'own';
export type Tier = 'own' | 'home' | 'dedicated' | 'community' | 'partner';
export interface Machine { id: string; tier: Tier; owner?: string; health: string; draining?: boolean; region: string; hourly: number | null; currency: string; free_ram_mb: number; free_slots: number; gpu_mb?: number; latency_ms?: number; queue_ms?: number; sessions?: number; state?: string; managed?: boolean; idle_since?: number; egress?: string }
export interface Request { strategy?: Strategy; owner?: string; kind?: string; ram_mb?: number; gpu_mb?: number; region?: string; machine?: string; public_egress?: boolean; max_hourly?: number }
export interface Pool { strategy?: Strategy; currency?: string; kind?: string; target_wait_ms?: number; max_hourly?: number; min_gain?: number; measured_peak_ram_mb?: number; min_warm?: number; max_machines?: number; slots_per_machine?: number; idle_grace_ms?: number }
export interface Decision { strategy: Strategy; selected: string | null; tier: Tier | null; hourly: number | null; currency: string; reasons: string[]; rejected: Array<{id: string; reason: string}>; switched: boolean; decided_at: string }
export function choose(request: Request, machines: Machine[], pool?: Pool, context?: {now?: number; current?: string | null}): Decision;
export function scale(pool: Pool, machines: Machine[], waiting: Array<{created_at: number}>, context?: {now?: number}): {actions: Array<{action: string; id?: string; reason: string}>; ram_per_session_mb: number; waiting: number; overdue: number; free_slots: number};
export function micros(value: string | number): bigint;
export function charge(hourlyMicros: bigint | string, milliseconds: number, quantumSeconds?: number): bigint;
export interface Quote { provider: string; id: string; region: string; hourly: number | null; currency: string; ram_mb: number; gpu_mb: number; setup: number; billing_seconds: number; tier: Tier; quoted_at: number; expires_at: number; provisionable?: boolean; reason?: string }
export interface Provider {id: string; configured: boolean; quote(request?: {gpu_mb?: number}): Promise<Quote[]>; provision(quote: Quote, spec: {label: string; image: string; command?: string[]; disk_gb?: number}): Promise<{id: string}>; health(id: string): Promise<{state?: string; deleted?: boolean}>; release(id: string): Promise<void>}
export function createProviders(options?: {fetch?: typeof fetch; config?: Record<string, {key?: string; application_secret?: string; consumer_key?: string; project?: string}>; now?: () => number}): Record<string, Provider>;
export const STRATEGIES: Strategy[];
export const TIERS: Tier[];
