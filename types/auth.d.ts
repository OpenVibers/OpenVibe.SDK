import type { TokenContext, TokenProvider, FetchLike, ServiceTokenClaims } from './core';
export * from './auth-browser';

export interface ServiceTokenClientOptions {
    network?: string;
    tokenUrl?: string;
    clientId: string;
    clientSecret: string;
    /** Default audience; each call from createClient passes the audience of the service it calls. */
    audience?: string;
    /** Capability ids to narrow the token to; a map narrows per audience. */
    scope?: string | string[] | Record<string, string | string[]>;
    fetch?: FetchLike;
    timeoutMs?: number;
    refreshSkewMs?: number;
    now?: () => number;
}
export interface TokenInfo {
    accessToken: string;
    tokenType: 'Bearer';
    audience: string;
    /** Capability ids the token endpoint granted. */
    scope: string[];
    expiresAt: string | null;
    /** The JWT payload decoded WITHOUT verification: for display and diagnostics only. */
    unverifiedClaims: Record<string, any> | null;
}
export interface ServiceTokenClient extends TokenProvider {
    getToken(ctx?: TokenContext): Promise<string>;
    getTokenInfo(ctx?: TokenContext): Promise<TokenInfo>;
    authHeaders(ctx?: TokenContext): Promise<{ Authorization: string }>;
    invalidate(ctx?: TokenContext): void;
    readonly tokenUrl: string;
}
export declare function createServiceTokenClient(opts: ServiceTokenClientOptions): ServiceTokenClient;

export interface UserTokenClaims {
    sub: number | string;
    id?: number | string;
    /** Canonical subject (usr_…); absent only on very old tokens. */
    subject_id?: string;
    username?: string;
    display_name?: string;
    role?: string;
    avatar_url?: string | null;
    iss?: string;
    aud?: string | string[];
    iat?: number;
    exp: number;
    [claim: string]: unknown;
}
export interface VerifyUserTokenOptions {
    /** JWKS document, or its URL (fetched and cached 6 h, refetched on an unknown kid). */
    jwks?: { keys?: object[]; public_key?: string } | string;
    /** PEM string or a crypto KeyObject instead of a JWKS. */
    publicKey?: string | object;
    issuer?: string;
    audience?: string | string[];
    clockSkewSec?: number;
    now?: number;
    fetch?: FetchLike;
    allowServiceTokens?: boolean;
}
export declare function verifyUserToken(token: string, opts: VerifyUserTokenOptions): Promise<UserTokenClaims>;

/** One JWKS key usable for RS256 verification. */
export interface JwksKey { kid: string | null; key: import('node:crypto').KeyObject; }
/** A JWKS client's state, for readiness endpoints. */
export interface JwksStatus {
    url: string;
    /** Keys are loaded (possibly stale): tokens can be verified. */
    ready: boolean;
    keys: number;
    fetchedAt: number | null;
    /** Past the TTL; still served while a refresh runs or fails. */
    stale: boolean;
    failures: number;
    lastError: string | null;
    nextTryAt: number | null;
}
export interface JwksClientOptions {
    fetch?: typeof fetch;
    /** Receives state changes (first failure, recovery), never per request. */
    log?: { warn?(msg: string): void; info?(msg: string): void; error?(msg: string): void; log?(msg: string): void } | null;
    /** Fresh for this long (default 6 h); after it the last keys are served while one refresh runs. */
    ttlMs?: number;
    /** Unknown-kid refetches are spaced at least this far apart (default 30 s). */
    minRefetchMs?: number;
    timeoutMs?: number;
    now?: () => number;
}
export interface JwksClient {
    url: string;
    /** The current keys: fresh ones, or the last good ones while a refresh runs or fails. */
    keys(): Promise<JwksKey[]>;
    /** Refetches when a token names a key the client does not have (a rotation), throttled. */
    keysForKid(kid: string | null | undefined): Promise<JwksKey[]>;
    refresh(): Promise<JwksKey[]>;
    status(): JwksStatus;
    /** Refresh in the background (an unref'd timer). */
    start(opts?: { intervalMs?: number }): JwksClient;
    stop(): void;
}
/** A new JWKS client (tests; services normally use jwksClient()). */
export declare function createJwksClient(url: string, opts?: JwksClientOptions): JwksClient;
/** The process-wide client for a JWKS URL (verifyUserToken/verifyAppToken share it). */
export declare function jwksClient(url: string, opts?: JwksClientOptions): JwksClient;
/** Every JWKS client this process uses, for /api/ready. */
export declare function jwksStatus(): JwksStatus[];

/** A developer app's token (identity.service-token-claims@1 with actor_type app). */
export type AppTokenClaims = ServiceTokenClaims & {
    sub: `app:app_${string}`;
    actor_type: 'app';
    /** [project_id] */
    ns: string[];
    project_id: string;
    env: 'sandbox' | 'production';
    /** usr_… of the person who authorized the app (authorization-code tokens only). */
    on_behalf_of?: string;
};
export interface VerifyAppTokenOptions {
    jwks?: { keys?: object[]; public_key?: string } | string;
    publicKey?: string | object;
    issuer?: string;
    /** Required: the audience your service answers for (openvibe.<service>). */
    audience: string | string[];
    /** Accept env=sandbox tokens (default false: token.sandbox_refused). */
    acceptSandbox?: boolean;
    clockSkewSec?: number;
    now?: number;
    fetch?: FetchLike;
}
export declare function verifyAppToken(token: string, opts: VerifyAppTokenOptions): Promise<AppTokenClaims>;

export interface UserTokenResponse {
    access_token: string;
    /** Absent for developer-app tokens: sign in again when they expire. */
    refresh_token?: string;
    token_type: 'Bearer';
    expires_in: number;
    scope?: string;
    user?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
}
export interface ExchangeCodeOptions {
    code: string;
    redirectUri: string;
    /** Required for public clients (no clientSecret) and for every developer app. */
    codeVerifier?: string;
    clientId: string;
    /** Confidential clients only; public apps send none. */
    clientSecret?: string;
    /** Developer apps (required for them): the audience the token is for. */
    audience?: string;
    /** Capability ids to narrow what the person authorized. */
    scope?: string | string[];
    network?: string;
    tokenUrl?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
}
export declare function exchangeCode(opts: ExchangeCodeOptions): Promise<UserTokenResponse>;
export declare function refreshUserToken(opts: { refreshToken: string; clientId: string; clientSecret: string; network?: string; tokenUrl?: string; fetch?: FetchLike; timeoutMs?: number }): Promise<UserTokenResponse>;

/** Per-person token cutoffs from network.user.token_valid_after (Contracts 0.39.0). */
export interface RevocationStore {
    /** Apply an envelope: 'revoked' when the cutoff moved, 'unchanged', or 'ignored:<why>'. */
    apply(event: unknown): 'revoked' | 'unchanged' | `ignored:${string}`;
    /** Keep the later cutoff; true when it moved forward. */
    record(subject: string, validAfterMs: number, reason?: string | null): boolean;
    /** True when claims.iat (seconds) is before claims.subject_id's cutoff. */
    isRevoked(claims: { iat?: number; subject_id?: string } | null | undefined): boolean;
    /** The cutoff in ms, 0 when none. */
    cutoffFor(subject: string): number;
    readonly EVENT_TYPE: 'network.user.token_valid_after';
}
export interface RevocationStoreOptions { table?: string; now?: () => number; maxCache?: number }
/** A better-sqlite3 handle keeps cutoffs across restarts; without one they live in memory. */
export declare function createRevocationStore(db?: unknown, opts?: RevocationStoreOptions): RevocationStore;
/** The same cutoffs on PostgreSQL: load() reads them into memory; apply()/record() write through (async). */
export interface PgRevocationStore {
    /** Read every stored cutoff into memory (at boot); resolves to how many. */
    load(): Promise<number>;
    apply(event: unknown): Promise<'revoked' | 'unchanged' | `ignored:${string}`>;
    record(subject: string, validAfterMs: number, reason?: string | null): Promise<boolean>;
    /** From memory: true when claims.iat (seconds) is before claims.subject_id's cutoff. */
    isRevoked(claims: { iat?: number; subject_id?: string } | null | undefined): boolean;
    cutoffFor(subject: string): number;
    loaded(): boolean;
    readonly EVENT_TYPE: 'network.user.token_valid_after';
}
/** An openvibe-sdk/db handle; the table comes from revocationSchema() in the service's migration. */
export declare function createPgRevocationStore(db: unknown, opts?: { table?: string; now?: () => number }): PgRevocationStore;
/** CREATE TABLE IF NOT EXISTS for createPgRevocationStore (default table ov_token_revocations). */
export declare function revocationSchema(table?: string): string;
export declare const TOKEN_VALID_AFTER: 'network.user.token_valid_after';
