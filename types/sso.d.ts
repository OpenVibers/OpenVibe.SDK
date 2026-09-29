import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from './core';
import type { UserTokenClaims } from './auth';

type Req = IncomingMessage & Record<string, any>;
type Res = ServerResponse & Record<string, any>;
type Next = (err?: unknown) => void;
type Handler = (req: Req, res: Res, next?: Next) => unknown;

export interface SsoClientOptions {
    /** Log prefix and the default extra audience openvibe.<site>. */
    site: string;
    /** This site's origin (post-sign-in targets, the redirect URI). */
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    networkUrl?: string;
    /** Token grants try this first, then networkUrl. */
    networkInternalUrl?: string;
    issuer?: string;
    /** Default <baseUrl>/auth/callback. */
    redirectUri?: string;
    scope?: string;
    /** Default ['openvibe.network', 'openvibe.<site>']. */
    audience?: string | string[];
    /** A pinned PEM instead of the JWKS. */
    publicKey?: string;
    secureCookies?: boolean;
    accessMaxAgeMs?: number;
    fetch?: FetchLike;
    log?: Pick<Console, 'warn' | 'log'>;
}

/** The verified session's claims without iat/exp/aud/iss/nbf/jti. */
export type SsoUser = Omit<UserTokenClaims, 'iat' | 'exp' | 'aud' | 'iss' | 'nbf' | 'jti'> & Record<string, unknown>;

export interface SsoClient {
    /** GET /login /callback /logout /me, POST /fedcm /refresh; mount at /auth. */
    router(express: any): any;
    handlers: { login: Handler; callback: Handler; fedcm: Handler; logout: Handler; me: Handler; refresh: Handler };
    /** Sets req.user and req.token when a valid session is presented. */
    optionalAuth(): (req: Req, res: Res, next: Next) => void;
    /** 401 JSON without a valid session. */
    requireAuth(): (req: Req, res: Res, next: Next) => void;
    /** The verified claims, or null. */
    verify(token: string | null | undefined): Promise<UserTokenClaims | null>;
    /** A Bearer header, else the ov_token cookie. */
    extractToken(req: Req): string | null;
    authorizeUrl(opts?: { silent?: boolean }): { url: string; state: string; verifier: string };
    tokenGrant(body: Record<string, unknown>): Promise<Record<string, any>>;
    redirectUri: string;
    audience: string | string[];
}

export declare function createSsoClient(opts: SsoClientOptions): SsoClient;
/** A same-site path, this site's https origin or the Network's; anything else (control characters, backslashes) is '/'. */
export declare function sanitizeNext(next: unknown, opts?: { baseUrl?: string; networkUrl?: string }): string;
export declare function withParam(target: string, key: string, value: string): string;
/** The payload of a JWT, unverified; null when it does not parse. */
export declare function decodeJwtPayload(token: string): Record<string, any> | null;
export declare function fedcmNonceMatches(token: string, nonce: string): boolean;
export declare function claimsToUser(claims: Record<string, any> | null): SsoUser | null;
export declare function parseCookies(req: { headers?: Record<string, any> }): Record<string, string>;
export declare const COOKIES: Readonly<{ access: string; refresh: string; hint: string }>;
