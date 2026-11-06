/**
 * openvibe-sdk/assertions: subject assertions (ADR-003, the 2026-11-06 amendment; plan H1).
 */
import type { FetchLike } from './core';
import type { JwksClient, JwksClientOptions } from './auth';
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


/** The header a money call carries the assertion in. */
export declare const ASSERTION_HEADER: string;
/** How long an assertion lives (seconds). */
export declare const ASSERTION_TTL_S: number;
/** The default replay window (milliseconds). */
export declare const REPLAY_WINDOW_MS: number;
/** How much clock difference is forgiven (seconds). */
export declare const CLOCK_SKEW_SEC: number;
