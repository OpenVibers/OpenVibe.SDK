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
}
export declare function createIdentityClient(client: OpenVibeClient, opts?: { baseUrl?: string }): IdentityClient;
