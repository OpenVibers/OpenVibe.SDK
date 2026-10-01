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
