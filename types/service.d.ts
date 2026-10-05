import type { IncomingMessage, Server, ServerResponse } from 'node:http';

type Req = IncomingMessage & Record<string, any>;
type Res = ServerResponse & Record<string, any>;
type Next = (err?: unknown) => void;
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;
type Step = () => unknown;

// ── graceful stop ───────────────────────────────────────────────

/** A handle closed after the close steps: a function, or an object with close() (else stop(), end(), quit()). */
export type StopHandle = (() => unknown) | { close(): unknown } | { stop(): unknown } | { end(): unknown } | { quit(): unknown };

export interface GracefulStopOptions {
    /** Log prefix, e.g. 'Network'. Default 'service'. */
    name?: string;
    /** The HTTP server to drain; leave it out for a worker without one. */
    server?: Server | null;
    /** Run first, in order (sync or async; a failure is logged and the stop goes on). */
    stop?: Step[];
    /** Run after the HTTP drain, in order. */
    close?: Step[];
    /** How long requests in flight may take before they are cut. Default 4000. */
    drainMs?: number;
    /** The whole stop; past it exit(deadlineExitCode). Default 5000. */
    deadlineMs?: number;
    /** Default 1 (Network, Community). The 5 s family and Media exit 0. */
    deadlineExitCode?: number;
    /** false: no SIGTERM/SIGINT handlers (tests; a caller that wires signals itself). Default true. */
    signals?: boolean;
    /** Default process.exit. Called once. */
    exit?: (code: number) => unknown;
    log?: Logger;
    /** After the stop steps, before the server stops taking connections. */
    beforeDrain?: (signal: string) => unknown;
    /** Closed after the close steps; a rejection makes the exit code 1. */
    handles?: StopHandle | StopHandle[];
}

export interface GracefulStop {
    /** Starts the stop once; later calls return the same promise. Resolves with the exit code passed to exit. */
    stop(signal?: string): Promise<number>;
    /** True from the first stop() (or signal) on: a readiness check can answer 503. */
    stopping(): boolean;
}

export declare function gracefulStop(options?: GracefulStopOptions): GracefulStop;
/** `promise`, but no longer than `ms`; a rejection is swallowed (a best-effort step inside the deadline). */
export declare function within<T>(ms: number, promise: Promise<T> | T): Promise<T | void>;
export declare const DRAIN_MS: 4000;
export declare const DEADLINE_MS: 5000;

// ── errors ──────────────────────────────────────────────────────

export interface ServiceErrorInstance extends Error {
    status: number;
    code: string;
    detail?: string;
    extra: Record<string, unknown> | null;
}

export interface ServiceErrorClass {
    new (status: number, code: string, detail?: string, extra?: Record<string, unknown> | null): ServiceErrorInstance;
    readonly prototype: ServiceErrorInstance;
}

export interface ServiceErrorOptions {
    /** Log prefix ([name]). Default 'service'. */
    name?: string;
    log?: Pick<Console, 'error'>;
    /** 'spread' (default: Blog/Trade, Reviews/Wiki) or 'details' ({ details: extra } below 500: Tips/VIP). */
    extra?: 'spread' | 'details';
    /** The code of an unexpected error. Default 'internal.error'. */
    internalCode?: string;
    /** The detail of an unexpected error. Default 'Internal error'. */
    internalDetail?: string;
    /** Map openvibe-publishing errors and plain TypeErrors (Blog/Trade asApiError). */
    publishing?: boolean;
    /** The class `publishing` builds. Default ServiceError. */
    ServiceError?: ServiceErrorClass;
    /** The service's own refusals → a ServiceError (or null). */
    map?: (err: unknown) => ServiceErrorInstance | null | undefined;
    /** run(): Cache-Control: private, no-store on the answer. */
    noStore?: boolean;
}

type Handler = (req: Req, res: Res, next?: Next) => unknown;

export declare const ServiceError: ServiceErrorClass;
export declare function createServiceError(name?: string): ServiceErrorClass;
export declare function asServiceError(err: unknown, options?: ServiceErrorOptions): ServiceErrorInstance | null;
/** Any error → problem+json. Returns the body sent, or null when the headers were already out. */
export declare function sendError(res: Res, req: Req, err: unknown, log?: Pick<Console, 'error'> | ServiceErrorOptions, options?: ServiceErrorOptions): Record<string, unknown> | null;
export declare function run<T>(fn: (req: Req, res: Res) => T | Promise<T>, status?: number | ((out: T) => number), options?: ServiceErrorOptions | Pick<Console, 'error'>): (req: Req, res: Res) => Promise<void>;
export declare function wrap(fn: Handler, options?: ServiceErrorOptions): (req: Req, res: Res, next?: Next) => Promise<void>;

export interface JsonBodyOptions {
    /** '512kb' (default), '1mb', or bytes. */
    limit?: string | number;
    /** Use this parser (express.json({ limit })) and map its errors. */
    parser?: (req: Req, res: Res, next: Next) => void;
}
export declare function jsonBody(options?: JsonBodyOptions): (req: Req, res: Res, next: Next) => void;
export declare function privateNoStore<R extends Res>(res: R): R;

export interface JsonErrorsOptions extends ServiceErrorOptions {
    /** Default ['/api/', '/internal/']. */
    apiPrefix?: string | string[];
    /** false: no 404 handler. */
    notFound?: boolean;
    notFoundText?: string;
    errorText?: string;
}
export type JsonErrors = [(req: Req, res: Res) => unknown, (err: unknown, req: Req, res: Res, next: Next) => unknown] & {
    notFound: (req: Req, res: Res) => unknown;
    errorHandler: (err: unknown, req: Req, res: Res, next: Next) => unknown;
};
export declare function jsonErrors(options?: JsonErrorsOptions): JsonErrors;

// ── telemetry: platform.telemetry-sample@1 at the request boundary ──

/** A platform.telemetry-sample@1 record. The schema allows only these fields; `extra` holds scalars. */
export interface TelemetrySample {
    service?: string;
    project?: string;
    subject?: string;
    resource?: string;
    provider?: string;
    node?: string;
    cell?: string;
    region?: string;
    operation?: string;
    at?: string;
    latency_ms?: number;
    queue_delay_ms?: number;
    ttfb_ms?: number;
    throughput_per_second?: number;
    bytes?: number;
    status?: string;
    cache_status?: string;
    cost_estimate?: number;
    route_epoch?: number;
    trace_id?: string;
    extra?: Record<string, string | number | boolean>;
}

/** Build a record in the schema's field order; `at` defaults to now (ISO) and null/undefined are stripped. */
export declare function telemetrySample(fields: Partial<TelemetrySample>): TelemetrySample;
/** `{ ok, errors }` against platform.telemetry-sample@1 (openvibe-contracts, required lazily; a missing
 *  package is never a claim of validity: `ok: false`, `errors: []`). */
export declare function validateTelemetrySample(record: unknown): { ok: boolean; errors: unknown[] };

/** start/stop/lag; the defaults are the SDK's event-loop monitor (started by init, stopped by stop). */
export interface TelemetrySignals {
    start(): void;
    stop(): void;
    lag(): number | null;
}

export interface HttpTelemetryOptions {
    /** The schema's `service` — the only process identity (there is no `instance` field). */
    service: string;
    /** Receives one batch per flush: `await sink(samples)`. */
    sink: (samples: TelemetrySample[]) => unknown;
    /** The flush interval; also the rolling p95 window. Default 15000. */
    intervalMs?: number;
    now?: () => number;
    log?: Logger;
    maxBuffered?: number;
    /** The route template for a request. Default: Express's `req.route.path` under `req.baseUrl`, else the path. */
    routeLabel?: (req: Req) => string;
    /** Replaces telemetrySkipped entirely. */
    skipped?: (req: Req) => boolean;
    /** Paths never observed. Default: /api/health, /ready, /api/ready, /metrics. */
    skipExact?: Set<string> | string[];
    /** Prefixes never observed (a path segment, e.g. Network's /shared, /api/chrome). Default []. */
    skipPrefixes?: string[];
    /** An extra always-skip predicate. */
    skip?: (req: Req) => boolean;
    /** Override the module's signals for this collector (tests; a service with its own monitor). */
    signals?: Partial<TelemetrySignals>;
}

export interface RequestObservation {
    route?: string;
    method?: string;
    httpStatus?: number;
    latencyMs?: number;
}

export interface HttpTelemetry {
    /** A number becomes `latency_ms`; any other value becomes `extra[name]` (a scalar dimension). */
    record(name: string, value: unknown, labels?: Record<string, unknown>): TelemetrySample;
    gauge(name: string, value: number, labels?: Record<string, unknown>): TelemetrySample;
    count(name: string, labels?: Record<string, unknown>): TelemetrySample;
    /** Emit the interval's aggregation, then hand the SDK everything buffered. */
    flush(): Promise<void>;
    /** Emit once, clear the timer and flush (idempotent; a gracefulStop stop step). */
    stop(): Promise<void>;
    /** A request began: the in-flight peak is sampled here. */
    requestStarted(): void;
    /** A request ended: free the in-flight slot and fold it by route|method|status_class. */
    requestFinished(info: RequestObservation): void;
    observeRequest(info?: RequestObservation): void;
    routeLabel(req: Req): string;
    skipped(req: Req): boolean;
    /** The per-request middleware for this collector. */
    middleware(options?: { routeLabel?: (req: Req) => string; skipped?: (req: Req) => boolean }): (req: Req, res: Res, next: Next) => void;
}

export declare function createHttpTelemetry(options: HttpTelemetryOptions): HttpTelemetry;
/** The middleware for a collector; telemetry never breaks a request and next() runs exactly once. */
export declare function createTelemetryMiddleware(collector: HttpTelemetry, options?: { routeLabel?: (req: Req) => string; skipped?: (req: Req) => boolean }): (req: Req, res: Res, next: Next) => void;
/** Whether a request carries no product signal (probe paths, configured prefixes, static assets). */
export declare function telemetrySkipped(req: Req, options?: { exact?: Set<string> | string[]; prefixes?: string[]; skip?: (req: Req) => boolean }): boolean;
/** The route label without openvibe-shared/metrics. */
export declare function defaultRouteLabel(req: Req): string;
/** Merge signals over the current defaults (a service or test injecting start/stop/lag). */
export declare function registerSignals(injected?: Partial<TelemetrySignals>): void;
export declare function startEventLoopMonitor(): void;
export declare function stopEventLoopMonitor(): void;
/** Whether the monitor is running; requiring the kit starts nothing. */
export declare function eventLoopMonitorEnabled(): boolean;
/** The event-loop lag since the last read, ms (the monitor resets per read); null before a sample. */
export declare function eventLoopLagMs(): number | null;
/** The singleton's middleware; a no-op until `telemetry.init()`. */
export declare const telemetryMiddleware: (req: Req, res: Res, next: Next) => void;
/** The process-wide collector: init at boot, stop on shutdown, nothing at require time. */
export declare const telemetry: {
    init(options: HttpTelemetryOptions): HttpTelemetry;
    record: HttpTelemetry['record'];
    gauge: HttpTelemetry['gauge'];
    count: HttpTelemetry['count'];
    requestStarted: HttpTelemetry['requestStarted'];
    requestFinished: HttpTelemetry['requestFinished'];
    flush: HttpTelemetry['flush'];
    stop: HttpTelemetry['stop'];
    middleware: (req: Req, res: Res, next: Next) => void;
};
export declare const DEFAULT_INTERVAL_MS: 15000;
export declare const HTTP_METHODS: Set<string>;

// ── re-exported from openvibe-shared and openvibe-contracts (loaded on first use) ──

type Fn = (...args: any[]) => any;
/** openvibe-shared/ready */
export declare const createReadiness: Fn;
export declare const skip: Fn;
export declare const safeReason: Fn;
/** openvibe-shared/metrics */
export declare const createRegistry: Fn;
export declare const instrument: Fn;
export declare const metricsHandler: Fn;
export declare const isLoopbackDirect: (req: Req) => boolean;
export declare const releaseInfo: Fn;
/** openvibe-shared/release */
export declare const createRelease: Fn;

export interface ProblemOptions {
    title?: string;
    detail?: string;
    type?: string;
    instance?: string;
    ctx?: { requestId?: string; traceId?: string } | null;
    errors?: unknown[];
    extra?: Record<string, unknown>;
}
/** openvibe-contracts http.problem */
export declare function problem(status: number, code: string, options?: ProblemOptions): Record<string, unknown>;
/** openvibe-contracts http.sendProblem */
export declare function sendProblem(res: Res, status: number, code: string, options?: ProblemOptions): Record<string, unknown>;
