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
    /** Receives the JWKS client's state changes (the first failure, the recovery). */
    log?: JwksClientOptions['log'];
    /** JWKS document, its URL (fetched and cached 6 h, refetched on an unknown kid), or a JWKS client you hold. */
    jwks?: { keys?: object[]; public_key?: string } | string | JwksClient;
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

export interface NetworkKeysOptions {
    /** Network's base URL (its JWKS is <network>/api/.well-known/jwks). */
    network?: string | null;
    /** The JWKS URL itself, instead of `network`. */
    jwksUrl?: string | null;
    /** A pinned key (PEM or KeyObject, e.g. OV_NETWORK_PUBLIC_KEY): used as is, never fetched. */
    publicKey?: string | import('node:crypto').KeyObject | null;
    fetch?: typeof fetch;
    log?: JwksClientOptions['log'];
    /** Until the first load, retry this often (default 30 s). */
    retryMs?: number;
    /** After it, refresh this often (default 15 min). */
    refreshMs?: number;
}
export type NetworkKeysStatus = { source: 'pinned'; url: null; ready: true; keys: 1 } | ({ source: 'jwks' } & JwksStatus);
export interface NetworkKeys {
    /** The JWKS URL, or null for a pinned key. */
    url: string | null;
    pinned: boolean;
    /** Spread into verifyUserToken / verifyAppToken / verifyServiceToken. */
    verifyOptions: { publicKey: import('node:crypto').KeyObject } | { jwks: JwksClient };
    /** A token can be verified (the readiness check). */
    loaded(): boolean;
    status(): NetworkKeysStatus;
    /** Fetch now and retry until the first load, then refresh (idempotent; resolves after the first attempt with loaded()). */
    start(): Promise<boolean>;
    stop(): void;
    /** One fetch now: the keys, or null when it failed. */
    refresh(): Promise<JwksKey[] | null>;
    /** The keys to check a token of your own with: the kid's after a rotation refetch, else every loaded key; [] when none. */
    keysFor(kid: string | null | undefined): Promise<JwksKey[]>;
}
/** The keys a service verifies Network tokens with: a pinned PEM, or Network's JWKS (rotation, last good keys, retry until loaded). */
export declare function createNetworkKeys(opts: NetworkKeysOptions): NetworkKeys;

/** The claims of a subject assertion (ADR-003, the 2026-11-06 amendment; plan H1). */
export interface SubjectAssertionClaims {
    /** The Network issuer. */
    iss: string;
    /** The person: usr_… */
    sub: string;
    /** The service the assertion is for (openvibe.billing). */
    aud: string | string[];
    /** The service the assertion was minted for (svc:live). */
    act?: string;
    /** Unique per assertion; a replayed one is refused. */
    jti: string;
    iat: number;
    exp: number;
    nbf?: number;
}
export type SubjectAssertionResult = { ok: true; claims: SubjectAssertionClaims } | { ok: false; code: string; reason: string };
export interface RequestSubjectAssertionOptions {
    /** The person's own Network access token (their session). Without it Network signs nothing. */
    userToken: string;
    /** The service the assertion is for (openvibe.billing). */
    audience: string;
    /** Where Network lives (public URL). */
    network?: string;
    /** Where Network's /internal lives (loopback, same host). */
    internalUrl?: string;
    /** The whole endpoint, when it is neither of the two above. */
    url?: string;
    /** The caller's own service token (Bearer). */
    token?: string;
    /** Or a client with getToken() (the SDK's createServiceTokenClient). */
    tokenClient?: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> };
    /** The person the caller says it acts for; Network checks it against the token. */
    subject?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    log?: JwksClientOptions['log'];
}
export interface SubjectAssertion {
    /** The signed JWT, to be sent as X-OV-Subject-Assertion. */
    assertion: string;
    /** The person the assertion names. */
    subject: string | null;
    audience: string;
    jti: string | null;
    expires_at: string | null;
    expires_in: number;
}
/** Ask Network to sign the person's own token into an assertion for one audience. */
export declare function requestSubjectAssertion(opts: RequestSubjectAssertionOptions): Promise<SubjectAssertion>;
export interface VerifySubjectAssertionOptions {
    /** Network's JWKS (a URL, a document or a client), or the EC public key. */
    jwks?: { keys?: object[]; public_key?: string } | string | JwksClient;
    publicKey?: string | object;
    /** The audience this service answers for (openvibe.billing). */
    audience?: string | string[];
    issuer?: string;
    /** The calling service the assertion must have been minted for (svc:live). */
    act?: string;
    clockSkewSec?: number;
    now?: number;
    /** A Map or Set of jtis already used: a replay is refused. */
    seen?: Set<string> | Map<string, number> | { has(jti: string): boolean };
    log?: JwksClientOptions['log'];
}
/** Check a subject assertion: signature, audience, expiry, the service it was minted for, the jti. */
export declare function verifySubjectAssertion(assertion: string, opts?: VerifySubjectAssertionOptions): Promise<SubjectAssertionResult>;
export interface SubjectAssertionVerifier {
    verify(assertion: string, opts?: { act?: string; seen?: Set<string> | Map<string, number> | { has(jti: string): boolean } }): Promise<SubjectAssertionResult>;
    /** How many jtis are remembered (the replay window). */
    size(): number;
}
/** A verifier that remembers the jtis it has seen, so a replayed assertion is refused. */
export declare function createSubjectAssertionVerifier(opts: { jwks?: VerifySubjectAssertionOptions['jwks']; audience?: string | string[]; issuer?: string; clockSkewSec?: number; replayWindowMs?: number; log?: JwksClientOptions['log'] }): SubjectAssertionVerifier;
/** The header a money call carries the assertion in. */
export declare function subjectAssertionHeader(assertion: string): { 'x-ov-subject-assertion': string };

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
    /** Receives the JWKS client's state changes (the first failure, the recovery). */
    log?: JwksClientOptions['log'];
    jwks?: { keys?: object[]; public_key?: string } | string | JwksClient;
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

/** The subset of openvibe-contracts verifyServiceToken needs (pass the service's own pinned module). */
export interface ContractsForServiceTokens {
    serviceAuth: { verifyServiceToken(token: string, opts: { publicKey: unknown; issuer?: string; audience?: string; acceptSandbox?: boolean }): ServiceTokenResult };
}
export type ServiceTokenResult = { ok: true; claims: Record<string, unknown> } | { ok: false; code: string; reason: string };
export interface VerifyServiceTokenOptions {
    /** A JWKS URL (the process-wide client: last good keys, rotation, backoff), a JWKS client the service already holds, or a JWKS document. */
    jwks?: string | JwksClient | { keys?: object[]; public_key?: string } | null;
    /** A pinned PEM instead of a JWKS. */
    publicKey?: string | object | null;
    issuer?: string;
    /** Required: the audience your service answers for (openvibe.<service>). */
    audience: string;
    /** Required: your pinned openvibe-contracts module; every token rule is its verifyServiceToken. */
    contracts: ContractsForServiceTokens;
    acceptSandbox?: boolean;
    log?: JwksClientOptions['log'];
    fetch?: FetchLike;
}
/** A service or app token: the SDK picks the key (the kid's, else each), your contracts module applies every rule. */
export declare function verifyServiceToken(token: string, opts: VerifyServiceTokenOptions): Promise<ServiceTokenResult>;

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

/** Per-person token cutoffs from network.user.token_valid_after (Contracts 0.39.0), on PostgreSQL: load() reads them into memory; apply()/record() write through (async). */
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
