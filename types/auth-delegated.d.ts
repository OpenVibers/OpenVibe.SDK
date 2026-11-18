// openvibe-sdk/auth/delegated (0.187.0): delegated person tokens. See src/auth/delegated.js.
import type { UserTokenClaims } from './auth';

/** A delegated token's claims as a site sees them (0.187.0): the person, role 'user', no staff claims. */
export interface DelegatedInfo { by: string; scope: 'read' | 'write'; services: string[] }
export declare const DELEGATED_TYP: 'delegated';
export declare const DELEGATED_MAX_TTL_SEC: number;
export declare function delegatedClaims(opts: {
    user: { id?: number | string; subject_id?: string; username?: string; display_name?: string; avatar_url?: string | null };
    by: string; services: string | string[]; scope?: 'read' | 'write'; ttlSec?: number; issuer?: string; audience?: string | string[]; now?: number;
}): UserTokenClaims & { typ: 'delegated'; svc: string[]; act: { sub: string }; scope: 'read' | 'write'; jti: string };
export declare function checkDelegated(claims: UserTokenClaims, service: string): UserTokenClaims & { delegated: DelegatedInfo };
export declare function isDelegated(userOrClaims: unknown): boolean;
export declare const STAFF_CLAIMS: readonly string[];
