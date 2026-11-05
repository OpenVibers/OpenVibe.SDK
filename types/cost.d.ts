/** platform.rate-card@1 and platform.cost-snapshot@1: provider pricing and cost windows. Validated by
 *  openvibe-contracts (required lazily by the validate* functions). */
export type RateCard = { id: string; provider: string; adapter?: string; side?: 'supply' | 'retail'; version?: string;
    metric: string; unit_size: number; unit_price_usd: number; free_allowance: number;
    reset_period: 'day' | 'month' | 'none'; region?: string; effective_from: string; effective_to?: string;
    effective_until?: string; source: string; verified_at: string };
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

// ── The AI Exchange money (decision D1): integer nano-USD, never floats ───────────────────────────────────────
/** One nano-USD: 1e-9 USD. */
export declare const NANO_USD: bigint;
/** Tokens per million: the denominator of every per-million-token rate. */
export declare const TOKENS_PER_MILLION: bigint;
/** The four token classes the settlement uses. */
export declare const TOKEN_CLASSES: readonly ['input_tokens', 'cached_read_tokens', 'cache_write_tokens', 'output_tokens'];
/** The rate field each token class is priced by. */
export declare const RATE_FIELDS: Record<string, string>;
/** The rates of one model: integer nano-USD per million tokens, or the nested settlement shape. */
export type NanoRate = { version?: string;
    input_nano_usd_per_m?: string; cached_read_nano_usd_per_m?: string; cache_write_nano_usd_per_m?: string;
    output_nano_usd_per_m?: string; per_request_nano_usd?: string;
    nano_usd_per_m?: { input?: string; cached_read?: string; cache_write?: string; output?: string } };
/** The tokens of one request, in the four classes. */
export type TokenUsage = { input_tokens?: number; cached_read_tokens?: number; cache_write_tokens?: number; output_tokens?: number };
/** A money amount as an integer count of nano-USD. A fraction is a bug, not a rounding opportunity. */
export declare function nanoUsd(value: string | number | bigint | null | undefined): bigint;
/** The charge of `tokens` at `rateNanoPerM`: ceil(tokens * rate / 1e6), rounded UP. */
export declare function chargeTokens(tokens: number, rateNanoPerM: string | number | bigint | null | undefined): bigint;
/** The expected cost of one request: each token class charged once, plus the per-request fee. */
export declare function expectedCostNano(usage: TokenUsage, rates: NanoRate | null | undefined): bigint;
/** The cost of one success: expected / max(p_success, floor), rounded UP to a whole nano-USD. */
export declare function costPerSuccessNano(expectedNano: bigint | string | number, pSuccess: number, floor?: number): bigint | null;
/** A money amount as the wire string. */
export declare function formatNanoUsd(nano: bigint | string | number): string;
/** The rate of one token class, from either shape a rate travels in. */
export declare function rateFor(rates: NanoRate | null | undefined, tokenClass: string): bigint;
