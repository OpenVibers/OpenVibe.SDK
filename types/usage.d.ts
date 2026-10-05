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

/** Anything with getToken({ audience }) — openvibe-sdk/auth's createServiceTokenClient. `invalidate` drops the
 *  cached token (called for a Billing 401 so the retry mints a fresh one). */
export type UsageTokenClient = { getToken(ctx?: { audience?: string; scope?: string | string[] }): Promise<string>;
    invalidate?(ctx?: { audience?: string }): void };

export type UsageReporterOptions = {
    /** An openvibe-sdk/db handle (server); the outbox table lives in the same database. */
    db: unknown;
    /** The Contracts service id (services/<id>.json), e.g. 'run', 'tools', 'ai'. */
    service: string;
    /** The sample's `source`, e.g. 'openvibe-node.worker', 'ai.runs'. */
    source: string;
    /** The outbox table (default 'usage_outbox'); services create it in a migration. */
    table?: string;
    /** OpenVibe.Billing's base URL; without it (or a tokenClient) only queueing happens. */
    billingUrl?: string;
    tokenClient?: UsageTokenClient | null;
    /** The token audience (default 'openvibe.billing'). */
    audience?: string;
    /** When true, `record()` refuses a reading whose `project` is not a `prj_…` id (default false: the
     *  reporter bills whatever reading it is given, so callers must never record first-party or sandbox traffic). */
    requireProject?: boolean;
    fetchImpl?: import('./core').FetchLike;
    /** The Billing POST timeout (default 5000). */
    timeoutMs?: number;
    /** The relay tick (default 2000). */
    intervalMs?: number;
    /** Readings per publish (default 1: one reading per request). */
    batchSize?: number;
    now?: () => number;
    log?: { warn?(...args: unknown[]): void };
};

/** One service's usage reporter: build/validate readings, queue them idempotency-keyed, relay to Billing. */
export interface UsageReporter {
    readonly enabled: boolean;
    readonly service: string;
    readonly source: string;
    readonly table: string;
    /** The service's stable key, e.g. key('job', id, n) -> 'run:job:<id>:<n>'. */
    key(...parts: (string | number)[]): string;
    /** A reading for this service and source; `id` defaults to `idempotency_key`. */
    sample(fields: Partial<UsageSample>): UsageSample;
    /** INSIDE the caller's transaction (db.tx's handle): queue the reading under its idempotency_key. The
     *  reporter bills whatever reading it is given — never record first-party or sandbox traffic; with
     *  `requireProject: true` a reading without a `prj_…` project is refused. */
    record(t: unknown, reading: UsageSample | Record<string, unknown>): Promise<boolean>;
    /** Create the outbox table where the handle may (tests, PGlite); services put it in a migration instead. */
    ensureSchema(): Promise<unknown>;
    start(): void;
    stop(): Promise<unknown>;
    kick(): void;
    flush(): Promise<{ sent: number; failed: number; rejected: number }>;
    prune(olderThanMs?: number): Promise<unknown>;
    pending(): Promise<number>;
    rejected(): Promise<number>;
}

/**
 * The shared step-7 reporter: readings queue idempotency-keyed in `table` inside the caller's transaction and
 * relay to Billing's billing.usage.record with createPgOutbox. Never dropped (transient failures — 5xx,
 * network errors and 4xx about credentials, grant, address or load: 401/403/404/408/425/429 — retry with
 * backoff across restarts; a 401 also drops the cached token); only Billing refusing the reading itself (any
 * other 4xx: 400, 402, 409, 410, 413, 415, 422 …) marks a row rejected, kept with its error and never sent again.
 */
export declare function createUsageReporter(options: UsageReporterOptions): UsageReporter;
