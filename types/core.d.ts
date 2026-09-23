import type { Problem } from './contracts';
export type { SubjectRef, ServiceTokenClaims, EntityRef, Problem, ServiceManifest, Capability, EventEnvelope, ModuleNamespace, ModuleRecord } from './contracts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TokenContext { service?: string; audience?: string; scope?: string | string[]; }

export interface TokenProvider {
    getToken(ctx?: TokenContext): Promise<string | null | undefined> | string | null | undefined;
    invalidate?(ctx?: TokenContext): void | Promise<void>;
}

export interface ClientOptions {
    /** Network origin: discovery (/.well-known/openvibe), registry, identity, modules. Default https://openvibe.network */
    network?: string;
    discoveryUrl?: string;
    /** Explicit origins per service id; win over discovery (e.g. host-internal http://127.0.0.1:4100 for media). */
    baseUrls?: Record<string, string>;
    /** Token audience per service; default `openvibe.<service>`. */
    audiences?: Record<string, string>;
    fetch?: FetchLike;
    /** Per attempt, default 10000. */
    timeoutMs?: number;
    /** Whole call including retries, default 30000. */
    deadlineMs?: number;
    /** Default 2. */
    retries?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    /** One of: a fixed Bearer token (user JWT, app key), a function, or a provider (createServiceTokenClient). */
    token?: string;
    getToken?: (ctx: TokenContext) => Promise<string | null | undefined> | string | null | undefined;
    tokenProvider?: TokenProvider;
    invalidateToken?: (ctx: TokenContext) => void | Promise<void>;
    headers?: Record<string, string>;
    /** Browser: 'include' sends the Network session cookie. */
    credentials?: RequestCredentials;
    discoveryTtlMs?: number;
    autoDiscover?: boolean;
    /** Contracts releases accepted from discovery; default CONTRACTS_RANGE. */
    contractsRange?: string;
    /** Throw sdk.incompatible_contracts instead of warning. */
    strictContracts?: boolean;
    /** Parent trace for calls without their own: a traceparent string or a getter (e.g. from AsyncLocalStorage). */
    traceparent?: string | (() => string | null | undefined) | null;
    onWarning?: (message: string) => void;
}

export interface RequestOptions {
    service?: string;
    baseUrl?: string;
    url?: string;
    path?: string;
    method?: string;
    query?: Record<string, string | number | boolean | string[] | null | undefined>;
    json?: unknown;
    form?: FormData;
    urlencoded?: Record<string, string | number | boolean | null | undefined> | URLSearchParams;
    body?: BodyInit;
    headers?: Record<string, string | undefined>;
    /** Per-call token; null sends none. */
    token?: string | null;
    /** false: never send Authorization. */
    auth?: boolean;
    audience?: string;
    /** A key makes a mutation retryable; false = never generate one (and never retry the mutation). */
    idempotencyKey?: string | false;
    /** The server dedupes this mutation by itself: retry without a key. */
    idempotent?: boolean;
    retries?: number;
    timeoutMs?: number;
    deadlineMs?: number;
    signal?: AbortSignal;
    traceparent?: string;
    requestId?: string;
    credentials?: RequestCredentials;
    /** 'response': a 2xx resolves with the raw fetch Response (body unread) as `data` and `response`. */
    responseType?: 'json' | 'text' | 'arrayBuffer' | 'response';
}

export interface ClientResponse<T = any> {
    status: number;
    headers: Headers;
    data: T;
    requestId: string;
    traceId: string;
    traceparent: string;
    attempts: number;
    /** Only with responseType 'response': the raw Response (same as data). */
    response?: Response;
}

export interface Discovery {
    issuer: string | null;
    tokenEndpoint: string | null;
    jwksUri: string | null;
    registry: string | null;
    services: Array<{ id: string; status: string; origin: string | null }>;
    origins: Record<string, string>;
    contractsVersion: string | null;
    contractsRange: string;
    compatible: boolean;
    fetchedAt: string;
    raw: any;
}

export interface OpenVibeClient {
    request<T = any>(opts: RequestOptions): Promise<ClientResponse<T>>;
    json<T = any>(opts: RequestOptions): Promise<T>;
    discover(opts?: { force?: boolean }): Promise<Discovery>;
    discovery(): Discovery | null;
    origin(service: string): Promise<string>;
    supports(service: string): Promise<boolean>;
    url(opts: Pick<RequestOptions, 'url' | 'service' | 'baseUrl' | 'path' | 'query'>): Promise<string>;
    audienceOf(service: string): string;
    traceparent(): string | null | undefined;
    withContext(ctx: { traceparent?: string; requestId?: string; headers?: Record<string, string> }): OpenVibeClient;
    fromRequest(req: { headers: any } | Headers | Record<string, any>): OpenVibeClient;
    readonly options: Readonly<Required<Pick<ClientOptions, 'network' | 'timeoutMs' | 'deadlineMs' | 'retries'>>> & Readonly<ClientOptions>;
}

export declare function createClient(options?: ClientOptions): OpenVibeClient;

export declare class OpenVibeError extends Error {
    name: 'OpenVibeError';
    /** Stable code: problem `code`, OAuth `error`, `http.<status>`, or `sdk.*`. */
    code: string;
    /** HTTP status; 0 for failures without a response. */
    status: number;
    title?: string;
    detail?: string;
    type?: string;
    requestId: string | null;
    traceId: string | null;
    errors?: Array<{ path?: string; message: string }>;
    problem: Problem | null;
    retryable: boolean;
    method?: string;
    url?: string;
    constructor(init?: Partial<Omit<OpenVibeError, 'name'>> & { message?: string; cause?: unknown });
    static fromResponse(init: { status: number; body: unknown; requestId?: string; traceId?: string; method?: string; url?: string; retryable?: boolean }): OpenVibeError;
    toJSON(): Record<string, unknown>;
}
export declare function isOpenVibeError(err: unknown): err is OpenVibeError;

export interface Page<T, C = unknown> { items: T[]; next?: C | null; }
export declare function paginate<T, C = unknown>(fetchPage: (cursor: C) => Promise<Page<T, C>>, opts?: { cursor?: C; maxPages?: number; maxItems?: number }): AsyncGenerator<T, void, unknown>;
export declare function offsetPager<T>(load: (offset: number, limit: number) => Promise<{ items: T[]; total?: number }>, opts?: { limit?: number }): (offset?: number) => Promise<Page<T, number>>;

export declare function parseTraceparent(value: unknown): { traceId: string; parentId: string; flags: string } | null;
export declare function startSpan(parent?: string | null): { traceId: string; spanId: string; parentId: string | null; traceparent: string };
export declare function contextFromHeaders(headers: any): { traceparent?: string; requestId?: string };

export declare function ulid(now?: number): string;
export declare function newEventId(now?: number): string;
export declare function newIdempotencyKey(): string;
export declare function isActingSubjectId(id: unknown): boolean;
export declare function satisfiesRange(version: string, range: string): boolean;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare const CONTRACTS_RANGE: string;
export declare const DEFAULT_NETWORK: string;
export declare const SDK_VERSION: string;
