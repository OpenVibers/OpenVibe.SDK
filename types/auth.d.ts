import type { TokenContext, TokenProvider, FetchLike } from './core';
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
export interface ServiceTokenClient extends TokenProvider {
    getToken(ctx?: TokenContext): Promise<string>;
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

export interface UserTokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type: 'Bearer';
    expires_in: number;
    scope?: string;
    user?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
}
export declare function exchangeCode(opts: { code: string; redirectUri: string; codeVerifier?: string; clientId: string; clientSecret: string; network?: string; tokenUrl?: string; fetch?: FetchLike; timeoutMs?: number }): Promise<UserTokenResponse>;
export declare function refreshUserToken(opts: { refreshToken: string; clientId: string; clientSecret: string; network?: string; tokenUrl?: string; fetch?: FetchLike; timeoutMs?: number }): Promise<UserTokenResponse>;
