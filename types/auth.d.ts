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
