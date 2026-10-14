/** platform.telemetry-sample@1: universal operation observation, product dimensions in extra. Validated by
 *  openvibe-contracts (required lazily by validateTelemetrySample, the first time it is called). */
export type TelemetrySample = { service: string; project?: string; subject?: string; resource?: string; provider?: string; node?: string;
    cell?: string; region?: string; operation: string; at: string; latency_ms?: number; queue_delay_ms?: number; ttfb_ms?: number;
    throughput_per_second?: number; bytes?: number; status?: string; cache_status?: string; cost_estimate?: number;
    route_epoch?: number; trace_id?: string; extra?: Record<string, string | number | boolean> };
export type ValidationError = { path: string; message: string };
/** `at` defaults to now (ISO); null/undefined fields are stripped. */
export declare function telemetrySample(fields: Partial<TelemetrySample>): TelemetrySample;
/** { ok, errors } against platform.telemetry-sample@1; a missing openvibe-contracts never claims validity (ok: false, errors: []). */
export declare function validateTelemetrySample(record: unknown): { ok: boolean; errors: ValidationError[] };
/** Labels are the sample's other fields (project, subject, resource, status, …); an `extra` object is merged in. */
export type TelemetryLabels = Partial<Omit<TelemetrySample, 'service' | 'operation' | 'at' | 'latency_ms'>>;
export interface TelemetryCollector {
    /** Builds `{ service, instance, operation: name, at, latency_ms: value, ...labels }` and queues it; a value that
     *  is not a number goes to `extra[name]` as a scalar. Returns the sample. */
    record(name: string, value: number | string | boolean, labels?: TelemetryLabels): TelemetrySample;
    /** A gauge's level, as record(name, value, labels). */
    gauge(name: string, value: number, labels?: TelemetryLabels): TelemetrySample;
    /** A counter's tick, as record(name, 1, labels). */
    count(name: string, labels?: TelemetryLabels): TelemetrySample;
    /** Await the sink for everything buffered; a rejection is logged once and the samples kept for the next flush. */
    flush(): Promise<void>;
    /** Clears the timer and flushes once (a gracefulStop stop step; a second stop changes nothing). */
    stop(): Promise<void>;
}
/** A collector: samples buffered and flushed to `await sink(samples)` every intervalMs (unref'd) and on stop();
 *  past maxBuffered the oldest sample is dropped, with a warning at most once a minute. */
export declare function createTelemetry(opts: { service?: string | null; instance?: string | null; sink: (samples: TelemetrySample[]) => Promise<void> | void;
    intervalMs?: number; now?: () => number; log?: { warn(...a: unknown[]): void; error(...a: unknown[]): void }; maxBuffered?: number }): TelemetryCollector;
/** Anything with openvibe-sdk/db's query(text, values) (a handle or a transaction's). */
export type TelemetryDb = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> };
/** The telemetry table's DDL for a service migration: platform.telemetry-sample@1's 21 columns in order (no
 *  `instance`), `extra` jsonb, indexes on (at) and (service, operation, at). The table name must match
 *  /^[a-z_][a-z0-9_]{0,62}$/ or it throws. Default `telemetry_samples`. */
export declare function telemetrySchema(table?: string): string;
/** A sink for createTelemetry() / createHttpTelemetry(): one multi-row parameterized INSERT per flush. A malformed
 *  sample is dropped with one warning and the rest stored; missing fields are NULL, `extra` is JSON; a rejected
 *  db.query propagates (the collector keeps the batch). */
export declare function createPgTelemetrySink(opts: { db: TelemetryDb; table?: string; log?: { warn(...a: unknown[]): void } }): (samples: TelemetrySample[]) => Promise<void>;
/** Retention: deletes rows whose `at` is older than olderThanDays (default 30); resolves with the count. */
export declare function pruneTelemetry(opts: { db: TelemetryDb; table?: string; olderThanDays?: number }): Promise<number>;
/** Scheduled retention: pruneTelemetry() delayMs after the call (default 60000) and then every everyMs (default
 *  86400000), on unref'd timers, so a service redeployed more than daily still prunes. A failing prune is logged
 *  and retried at the next tick; runs never overlap. run() prunes now (resolves with the count, 0 on failure);
 *  stop() cancels the timers and waits for a run in flight. */
export declare function startTelemetryRetention(opts: { db: TelemetryDb; table?: string; olderThanDays?: number; everyMs?: number; delayMs?: number;
    log?: { error(...a: unknown[]): void } }): { run(): Promise<number>; stop(): Promise<void> };
