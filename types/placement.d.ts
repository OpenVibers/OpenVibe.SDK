/** platform.* contract shapes are validated by openvibe-contracts; these are the fields the planner reads. */
export type Offer = { offer_id: string; kind: 'node' | 'provider' | 'storage' | 'delivery' | 'runtime' | 'agent' | 'harness'; provider?: string; model?: string; harness?: string;
    region: string; regions?: string[]; trust: 'first-party' | 'user-owned' | 'partner' | 'community' | 'external';
    owner?: string;
    capabilities: string[]; capacity?: Record<string, any>; latency_ms?: Record<string, number>; health: { status: 'up' | 'degraded' | 'down' | 'draining'; streaming?: boolean };
    pricing: { model: string; marginal_usd_per_unit?: number; rate_card?: string };
    detail?: { model?: string; harness?: string; provider?: string; [key: string]: any } };
export type Requirements = { kind: string; mobility: 'request' | 'job' | 'session' | 'stateful-partition'; latency_class: 'realtime' | 'interactive' | 'background' | 'bulk' | 'critical';
    objective: 'cheapest' | 'lowest-latency' | 'balanced' | 'private' | 'local-only' | 'first-party-only' | 'high-reliability' | 'correctness';
    max_latency_ms?: number; max_cost_usd?: number; residency?: string; region?: string; trust?: string[]; capabilities?: string[];
    resources?: { cpu?: number; memory_mb?: number; gpu?: boolean }; units?: number; authority?: string; latency_op?: string };
export type RateCard = { id: string; provider: string; metric: string; unit_size: number; unit_price_usd: number; free_allowance: number; reset_period: string };
export type ProviderState = { provider: string; period_start: string; period_end: string; usage: Record<string, number>; forecast?: Record<string, number>; reserve?: Record<string, number> };
export type Candidate = { id: string; eligible: boolean; excluded_because?: string; estimated_cost_usd?: number; estimated_latency_ms?: number; score?: number };
export type PlacementResult = { selected: string | null; objective: string; reasons: string[]; candidates: Candidate[]; decided_at: string };
export declare function plan(req: Requirements, offers: Offer[], opts?: { rateCards?: RateCard[] | Map<string, RateCard>; states?: ProviderState[] | Map<string, ProviderState>;
    now?: number; current?: string | null; minGain?: number; weights?: { cost: number; latency: number }; owned?: { busy?: number; full?: number; maxUsd?: number };
    success?: Record<string, number> | Map<string, number> }): PlacementResult;
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

/** One stored (option, kind) count for a person; the counts are decayed with a 14-day half-life. */
export type Outcome = { person: string; key: string; kind: string; ok_w: number; n_w: number; updated_at: string };

export type PlacementRules = {
    noCloud?: boolean; onlyFree?: boolean; region?: string; uncensored?: boolean; maxCostUsd?: number;
    prefer?: 'cheapest' | 'fastest' | 'balanced';
};

export type PlaceOptions = {
    rateCards?: RateCard[] | Map<string, RateCard>; states?: ProviderState[] | Map<string, ProviderState>;
    now?: number; current?: string | null; minGain?: number; weights?: { cost: number; latency: number };
    owned?: { busy?: number; full?: number; maxUsd?: number };
    person?: string; step?: { kind: string }; floor?: number;
    priors?: Record<string, number>; outcomes?: Outcome[]; rules?: PlacementRules;
    names?: Record<string, string>;
    /** ids (and their plain reason) an escalation keeps out for this step. */
    exclude?: Record<string, string>;
    escalations?: number;
};

export type RankedOption = { id: string; success: number; cost_usd: number; cost_per_success_usd: number };
export type RejectedOption = { id: string; why: string };

export type PlaceAnswer = {
    result: PlacementResult;
    line: string;
    ranked: RankedOption[];
    rejected: RejectedOption[];
    fallback: { id: string; success: number } | null;
    floor: number;
    escalations: number;
    excluded: string[];
};

export type PlacementFailure = {
    reason: 'quality' | 'busy' | 'offline' | 'refused' | 'budget' | 'timeout';
    option_id?: string;
    id?: string;
    provider?: string;
};

export type EscalationAnswer = {
    result: PlacementResult | { selected: null };
    line: string;
    ranked?: RankedOption[];
    rejected?: RejectedOption[];
    fallback?: { id: string; success: number } | null;
    floor?: number;
    escalations: number;
    excluded: string[];
    outcomes: Outcome[];
};

export type LineFacts = {
    selected?: boolean;
    name?: string;
    owned?: boolean;
    free?: boolean;
    signIn?: boolean;
    files?: boolean;
    provider?: string;
    streaming?: string | null;
    cores?: number;
    gpu?: boolean;
    staying?: boolean;
    gain?: number | null;
    cheapest?: boolean;
    costUsd?: number;
    success?: number;
    step?: string;
    fallback?: { name: string; success: number } | null;
    previousName?: string;
    failure?: { reason: PlacementFailure['reason']; count?: number } | null;
};

/** The option key: offer_id plus the offer's model (or harness) when it carries one. */
export declare function optionKey(offer: Offer): string;
/** Add one try to the plain outcome counts, decayed to `at`; returns new data and never mutates the input. */
export declare function learn(outcomes: Outcome[], entry: { person: string; key: string; kind: string; ok: boolean; at: number | string }): Outcome[];
/** The Beta-mean success estimate for (person, key, kind), with decay, a Bench prior and everyone else's counts. */
export declare function successOf(outcomes: Outcome[], opts: { person?: string; key: string; kind?: string; prior?: number; now?: number | string }): number;
/** The one-sentence explanation from fixed templates. */
export declare function lineFor(facts: LineFacts): string;
/** plan() plus the person's rules, ownership, the quality bar, success estimates and the line. */
export declare function place(req: Requirements, offers: Offer[], opts?: PlaceOptions): PlaceAnswer;
/** The next place() answer after a failure, or the ask-the-person answer after two escalations. */
export declare function escalate(previous: PlaceAnswer, failure: PlacementFailure, req: Requirements, offers: Offer[], opts?: PlaceOptions): EscalationAnswer;

/** The five trust classes (T1 ADR-046): first-party, user-owned, partner, community, external. */
export declare const TRUST_CLASSES: readonly ['first-party', 'user-owned', 'partner', 'community', 'external'];
/** The preference order across the five classes (all five). */
export declare const TRUST_ORDER: readonly ['first-party', 'user-owned', 'partner', 'community', 'external'];
/** platform.workload-requirements@1's default when `trust` is absent: user-owned is never a default. */
export declare const DEFAULT_TRUST: readonly ['first-party', 'partner', 'community', 'external'];
