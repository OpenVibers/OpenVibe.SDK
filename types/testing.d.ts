import type { FetchLike, EventEnvelope, Capability, ServiceManifest, ModuleNamespace } from './core';

export interface MockGrant { capability: string; audience: string; namespaces?: string[]; }
export interface MockUser { id: number | string; subject_id: string; username: string; display_name?: string; role?: string; legacy: Array<{ system: string; type?: string; id: string | number }>; }
export interface MockPlatformOptions {
    origins?: Partial<Record<'network' | 'events' | 'media' | 'community', string>>;
    issuer?: string;
    contractsVersion?: string;
    clients?: Record<string, { secret: string; grants?: Array<MockGrant | [string, string, string[]?]>; redirectUris?: string[] }>;
    users?: Array<Partial<MockUser>>;
    mediaApps?: Record<string, { apiKey?: string }>;
    namespaces?: ModuleNamespace[];
    capabilities?: Capability[];
    services?: ServiceManifest[];
    realtimeRetryMs?: number;
}
export interface MockPlatform {
    fetch: FetchLike;
    origins: Record<'network' | 'events' | 'media' | 'community', string>;
    issuer: string;
    keys: { privateKey: object; publicKey: object; jwks: { keys: object[]; public_key: string; algorithm: 'RS256' } };
    signUserToken(user: MockUser | string, opts?: { expiresInSec?: number; audience?: string[] }): string;
    signServiceToken(clientId: string, opts: { audience: string; capabilities?: string[]; namespaces?: string[]; expiresInSec?: number }): string;
    addClient(id: string, client: { secret: string; grants?: Array<MockGrant | [string, string, string[]?]>; redirectUris?: string[] }): void;
    addUser(user?: Partial<MockUser>): MockUser;
    /** What the Network does after the account chooser: returns an authorization code. */
    authorize(opts: { clientId: string; redirectUri: string; subjectId?: string; codeChallenge?: string; codeChallengeMethod?: 'S256'; scope?: string }): string;
    stats: { tokenRequests: number; requests: Array<{ method: string; url: string; headers: Record<string, string> }> };
    state: { events: Array<{ seq: number; event: EventEnvelope; publisher: string }>; subscriptions: Map<string, any>; modules: Map<string, any>; files: Map<string, any>; users: Map<string, MockUser>; checkpoints: Map<string, number> };
    publishEvent(envelope: Partial<EventEnvelope> & Pick<EventEnvelope, 'event_type' | 'source' | 'actor' | 'subject'>, publisher?: string): { event_id: string; seq: number; duplicate: boolean };
    dropRealtime(): void;
}
export declare function createMockPlatform(opts?: MockPlatformOptions): MockPlatform;
export declare const DEFAULT_ORIGINS: Record<'network' | 'events' | 'media' | 'community', string>;
