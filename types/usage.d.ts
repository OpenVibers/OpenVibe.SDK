/** platform.usage-sample@1: one metered usage reading with retry-safe attribution. Validated by openvibe-contracts
 *  (required lazily by validateUsageSample, the first time it is called). */
export type UsageSample = { id: string; idempotency_key: string; service: string; project?: string; subject?: string; resource?: string;
    provider?: string; node?: string; cell?: string; region?: string; operation: string; quantity: number; unit: string; at: string;
    /** Money fields are the caller's (rating is Billing's); usageSample never invents them. */
    cost_estimate?: number; free_allowance_used?: number; vibes_charged?: number; route_epoch?: number; trace_id?: string; source: string };
export type ValidationError = { path: string; message: string };
/** `at` defaults to now (ISO) and `source` to 'openvibe-sdk/usage'; null/undefined fields are stripped. */
export declare function usageSample(fields: Partial<UsageSample>): UsageSample;
/** The stable idempotency key of a reading: the service, then each part, joined with ':'; a non-empty service is required. */
export declare function usageKey(service: string, ...parts: (string | number)[]): string;
/** { ok, errors } against platform.usage-sample@1; a missing openvibe-contracts never claims validity (ok: false, errors: []). */
export declare function validateUsageSample(record: unknown): { ok: boolean; errors: ValidationError[] };
