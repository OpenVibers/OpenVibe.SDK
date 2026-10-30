import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from './core';

type Req = IncomingMessage & Record<string, any>;
type Res = ServerResponse & Record<string, any>;
type Next = (err?: unknown) => void;
type Handler = (req: Req, res: Res, next?: Next) => unknown;

/** The app token's claims: who signed in, what this app may do for them, until when. */
export interface AppSessionUser {
    /** The person (usr_…) who authorized this app. */
    subject: string;
    /** The token's subject: app:<your app id>. */
    app: string;
    project_id: string | null;
    env: 'sandbox' | 'production' | null;
    /** The capability ids the person authorized. */
    capabilities: string[];
    expires_at: string;
}

export interface AppSession {
    get(req: Req): unknown | Promise<unknown>;
    set(req: Req, res: Res, session: unknown): unknown | Promise<unknown>;
    clear?(req: Req, res: Res): unknown | Promise<unknown>;
}

export interface AppSignInOptions {
    /** The app's id (app_…). */
    clientId: string;
    /** The app's secret. Confidential apps need it; it never leaves the server. */
    clientSecret?: string;
    /** The exact URI the Network redirects back to (it must be registered for this app). */
    redirectUri: string;
    /** The Network (default https://openvibe.network). */
    networkUrl?: string;
    /** The one audience the token is for (openvibe.<service>). */
    audience?: string;
    /** The capability ids to ask for. */
    scope?: string[] | string;
    /** The same thing under another name. */
    scopes?: string[] | string;
    /** This app's origin (post-sign-in targets). Default: the redirect URI's origin. */
    baseUrl?: string;
    /** The name the sign-in pages show. */
    siteName?: string;
    appName?: string;
    /** Your own session store: get/set (and clear, for a sign-out). */
    session?: AppSession;
    /** The cookie that holds the opaque session id (the in-memory fallback, when no session is given). */
    cookie?: { name?: string; sameSite?: string; maxAge?: number };
    cookieName?: string;
    secureCookies?: boolean;
    /** A pinned PEM instead of the JWKS. */
    publicKey?: string;
    jwks?: string;
    issuer?: string;
    /** Accept sandbox tokens (default true: a sandbox app signs people in in development). */
    acceptSandbox?: boolean;
    fetch?: FetchLike;
    log?: Pick<Console, 'warn' | 'log'> & Partial<Pick<Console, 'error'>>;
}

export interface AppSignIn {
    /** GET /login /callback /logout /me /health. */
    router(express: any): any;
    handlers: { login: Handler; callback: Handler; logout: Handler; me: Handler; health: Handler };
    /** The verified claims of an app token minted for THIS app, or null. */
    verify(token: string | null | undefined): Promise<Record<string, any> | null>;
    /** Does the Network accept this app's credentials? Cached 10 minutes; GET /health answers with it (503 when 'invalid'). */
    checkClient(opts?: { force?: boolean }): Promise<'ok' | 'invalid' | 'unknown'>;
    redirectUri: string;
    audience: string;
    scope: string[];
    clientId: string;
}

/** "Sign in with OpenVibe" for developer apps: the routes, the session and the recovery, in one call. */
export declare function createAppSignIn(opts: AppSignInOptions): AppSignIn;
/** The capability ids to ask for, as the Network takes them. */
export declare function normalizeScope(scope: string[] | string | undefined | null): string[] | undefined;
