/** platform.rate-card@1 and platform.cost-snapshot@1: provider pricing and cost windows. Validated by
 *  openvibe-contracts (required lazily by the validate* functions). */
export type RateCard = { id: string; provider: string; adapter?: string; metric: string; unit_size: number;
    unit_price_usd: number; free_allowance: number; reset_period: 'day' | 'month' | 'none'; region?: string;
    effective_from: string; effective_until?: string; source: string; verified_at: string };
export type CostSnapshotTarget = { id: string; units: number; cost_usd: number; p50_ms?: number; p95_ms?: number };
export type CostSnapshot = { window_start: string; window_end: string; project_id?: string; scope: string;
    by_target: CostSnapshotTarget[]; actual_usd: number; counterfactual_usd?: Record<string, number> };
export type EstimateResult = { quantity: number; unit: string | null; billable: number; cost_usd: number };
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function rateCard(fields: Partial<RateCard>): RateCard;
export declare function costSnapshot(fields: Partial<CostSnapshot>): CostSnapshot;
/** The cost of `quantity` units in one rate card after its free allowance. */
export declare function estimate(card: RateCard, quantity: number, unit?: string): EstimateResult;
export declare function validateRateCard(record: unknown): { ok: boolean; errors: ValidationError[] };
export declare function validateCostSnapshot(record: unknown): { ok: boolean; errors: ValidationError[] };
