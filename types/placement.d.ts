/** platform.* contract shapes are validated by openvibe-contracts; these are the fields the planner reads. */
export type Offer = { offer_id: string; kind: 'node' | 'provider'; provider?: string; region: string; regions?: string[]; trust: 'first-party' | 'user-owned' | 'partner' | 'community' | 'external';
    capabilities: string[]; capacity?: Record<string, any>; latency_ms?: Record<string, number>; health: { status: 'up' | 'degraded' | 'down' | 'draining' };
    pricing: { model: string; marginal_usd_per_unit?: number; rate_card?: string } };
export type Requirements = { kind: string; mobility: 'request' | 'job' | 'session' | 'stateful-partition'; latency_class: 'realtime' | 'interactive' | 'background' | 'bulk' | 'critical';
    objective: 'cheapest' | 'lowest-latency' | 'balanced' | 'private' | 'local-only' | 'first-party-only' | 'high-reliability' | 'correctness';
    max_latency_ms?: number; max_cost_usd?: number; residency?: string; region?: string; trust?: string[]; capabilities?: string[];
    resources?: { cpu?: number; memory_mb?: number; gpu?: boolean }; units?: number; authority?: string; latency_op?: string };
export type RateCard = { id: string; provider: string; metric: string; unit_size: number; unit_price_usd: number; free_allowance: number; reset_period: string };
export type ProviderState = { provider: string; period_start: string; period_end: string; usage: Record<string, number>; forecast?: Record<string, number>; reserve?: Record<string, number> };
export type Candidate = { id: string; eligible: boolean; excluded_because?: string; estimated_cost_usd?: number; estimated_latency_ms?: number; score?: number };
export type PlacementResult = { selected: string | null; objective: string; reasons: string[]; candidates: Candidate[]; decided_at: string };
export declare function plan(req: Requirements, offers: Offer[], opts?: { rateCards?: RateCard[] | Map<string, RateCard>; states?: ProviderState[] | Map<string, ProviderState>;
    now?: number; current?: string | null; minGain?: number; weights?: { cost: number; latency: number }; owned?: { busy?: number; full?: number; maxUsd?: number } }): PlacementResult;
export declare function excluded(req: Requirements, offer: Offer): string | null;
export declare function marginalCost(card: RateCard, state: ProviderState | undefined, projected: number, opts?: { now?: number; priority?: 'normal' | 'high' }): number;
export declare function priceOf(card: RateCard, units: number): number;
export declare function forecast(used: number, start: number, end: number, now: number): number;
export declare function ownedLoadCost(offer: Offer, opts?: { busy?: number; full?: number; maxUsd?: number }): number;
export declare function rendezvous<T extends { id: string; weight?: number }>(key: string, targets: T[]): T | null;
export declare function pickTwo<T>(items: T[], load: (x: T) => number, rand?: () => number): T | null;
export type RoutePlan = { epoch: number; issued_at: string; expires_at: string; issuer: string; key_id: string; routes: { route: string; targets: { id: string; weight: number }[]; draining?: string[]; since_epoch?: number }[]; signature?: string };
export declare function signPlan(plan: RoutePlan, privateKey: any): RoutePlan;
export declare function verifyPlan(plan: RoutePlan, publicKeys: Record<string, any>, opts?: { now?: number }): { ok: boolean; reason?: string };
export declare function createPlanHolder(publicKeys: Record<string, any>, opts?: { now?: () => number; onReject?: (why: string) => void }): { get(): RoutePlan | null; accept(p: RoutePlan): boolean; targets(route: string): { id: string; weight: number }[] | null };
export declare function canonical(v: unknown): string;
/** The five trust classes (T1 ADR-046): first-party, user-owned, partner, community, external. */
export declare const TRUST_CLASSES: readonly ['first-party', 'user-owned', 'partner', 'community', 'external'];
