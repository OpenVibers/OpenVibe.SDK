import type { IncomingMessage, ServerResponse } from 'node:http';

type Req = IncomingMessage & Record<string, any>;
type Res = ServerResponse & Record<string, any>;
type Next = (err?: unknown) => void;
type Middleware = (req: Req, res: Res, next: Next) => void;
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

// ── the Network's signing key (was server/auth/keys.js in 31 sites) ──

/** A site's config: the flat shape or the nested one. */
export interface KeyStoreConfig {
    networkInternalUrl?: string;
    networkUrl?: string;
    network?: { internalUrl?: string; url?: string };
    [key: string]: unknown;
}

export interface KeyStoreOptions {
    config: KeyStoreConfig;
    /** Log prefix, e.g. 'OpenVibe.Blog'. Default 'site'. */
    name?: string;
    fetchImpl?: typeof fetch;
    log?: Logger;
}

export type VerifyResult =
    | { ok: true; claims: Record<string, any> }
    | { ok: false; reason: string; code?: string; expired?: boolean };

export interface KeyStore {
    ensure(): Promise<void>;
    get(): string | null;
    loaded(): boolean;
    status: unknown;
    verifyUser(token: string, o?: { issuer?: string; audience?: string | string[]; now?: number | (() => number) }): Promise<VerifyResult>;
    verifyApp(token: string, o?: { issuer?: string; audience?: string | string[]; acceptSandbox?: boolean; now?: number | (() => number) }): Promise<VerifyResult>;
    pemForToken(token: string): Promise<string | null>;
    client: unknown;
}

export const KEY_UNAVAILABLE: string;
export const DOES_NOT_VERIFY: string;
export function createKeyStore(o: KeyStoreOptions): KeyStore;
export function jwksUrl(config: KeyStoreConfig): string;
export function publicReason(err: unknown): string;

// ── async routes (was server/http/router.js in 27 sites) ──

export const ASYNC_METHODS: string[];
export function wrapHandler<T>(h: T): T;
/** An Express Router (or { express } to make one) whose async handlers send a rejection to next(err). */
export function asyncRouter<R = any>(routerOrOptions: R | { express: { Router(): R } }, o?: { methods?: string[] }): R;

// ── the Link: header (was server/link-header.js in 8 sites) ──

export function linksOf(html: string): string | null;
export function linkHeader(): Middleware;

// ── GET /openapi.json (was server/http/openapi-routes.js in 8 sites) ──

export interface OpenapiOptions {
    title: string;
    description?: string;
    version?: string | number;
    baseUrl: string;
    docs?: string;
    apiBase?: string;
    /** The API source files whose header comments name the routes ("GET /x   what it does"). */
    files?: string[];
}
export const OPENAPI_METHODS: string[];
export function openapiRoute(app: any, o: OpenapiOptions): (req: Req, res: Res) => void;
export function routesOf(router: any, prefix?: string, out?: Array<{ method: string; path: string }>): Array<{ method: string; path: string }>;
export function summariesFrom(files: string[], apiBase: string): Record<string, string>;
export function mountPathOf(layer: any): string | null;

// ── times leave with their zone (was server/iso-times.js in 5 services) ──

export const TIME_KEY: RegExp;
export const SQL_TEXT_TIME: RegExp;
export function isoTime<T>(value: T): T | string;
export function normalizeTimes<T>(value: T, depth?: number): T;
export function isoJsonTimes(req: Req, res: Res, next: Next): void;
export function storedTime(value: unknown): string | null;

// ── Markdown twins of public pages (was server/agent-twins.js in 9 sites) ──

export interface TwinsOptions {
    /** express itself (the SDK does not depend on it). */
    express?: any;
    /** openvibe-shared/agent-layer. */
    agentLayer?: { mount(router: any, o: any): void; linkHeaderTags(url: string, llms: string): { head: string; header: string } };
    /** The public pages that have twins. */
    paths: RegExp;
}
export interface Twins {
    mountTwins(app: any, o: { router: any; descriptor: unknown; baseUrl: string; llms?: string }): void;
    renderWithRouter(router: any, path: string, host: string): Promise<string | null>;
    mockReq(path: string, host: string): Req;
    mockRes(): Res;
    wantsTwin(req: Req): boolean;
    TWIN_PATH_RE: RegExp;
}
export function createTwins(o: TwinsOptions): Twins;
