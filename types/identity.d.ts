import type { OpenVibeClient, SubjectRef } from './core';

export interface SubjectProjection {
    subject: SubjectRef;
    network_user_id?: number;
    network_anon_id?: number;
    username: string;
    display_name: string;
    avatar_url: string | null;
    banned: boolean;
    [field: string]: unknown;
}
export type ResolveInput = { subjectId: string } | { system: string; type?: string; id: string | number };
export type ResolveBatchInput = { subjectIds: string[] } | { system: string; type?: string; ids: Array<string | number> };

export interface IdentityClient {
    resolve(input: ResolveInput): Promise<SubjectProjection | null>;
    resolveBatch(input: ResolveBatchInput): Promise<Record<string, SubjectProjection | null>>;
    isEmailVerified(input: { subject: string; email: string }): Promise<boolean>;
}
export declare function createIdentityClient(client: OpenVibeClient, opts?: { baseUrl?: string }): IdentityClient;

export interface AccountEmail {
    id: string;
    email: string;
    verified: boolean;
    verified_at: string | null;
    primary: boolean;
    created_at: string;
}
export interface AccountEmailsClient {
    list(): Promise<{ emails: AccountEmail[] }>;
    add(email: string): Promise<{ ok: boolean; message: string }>;
    verify(id: string): Promise<{ ok: boolean; message: string }>;
    remove(id: string): Promise<{ ok: boolean; emails: AccountEmail[] }>;
    makePrimary(id: string): Promise<{ ok: boolean; emails: AccountEmail[] }>;
}
/** Manage the current person's own addresses with an OpenVibe.Network user access token. */
export declare function createAccountEmailsClient(opts: {
    networkUrl?: string;
    getToken: () => string | Promise<string>;
    fetchImpl?: typeof fetch;
}): AccountEmailsClient;
