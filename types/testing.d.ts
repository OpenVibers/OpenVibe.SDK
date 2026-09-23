import type { FetchLike, EventEnvelope, Capability, ServiceManifest, ModuleNamespace } from './core';
import type { ToolDescriptor } from './contracts';

type Origin = 'network' | 'events' | 'media' | 'community' | 'tools';
export interface MockGrant { capability: string; audience: string; namespaces?: string[]; }
export interface MockUser { id: number | string; subject_id: string; username: string; display_name?: string; role?: string; legacy: Array<{ system: string; type?: string; id: string | number }>; }
export interface MockAppSpec {
    /** app_<ULID>; generated when omitted (addApp). */
    id?: string;
    /** prj_<ULID>; a project is created when omitted or unknown. */
    project?: string;
    name?: string;
    env?: 'sandbox' | 'production';
    environment?: 'sandbox' | 'production';
    type?: 'confidential' | 'public';
    /** Confidential apps: the client secret (generated when omitted). */
    secret?: string;
    redirectUris?: string[];
    /** Approved grants: capability ids (audience openvibe.<owner>) or { capability, audience }. */
    grants?: Array<string | { capability: string; audience?: string }>;
}
export interface MockProjectSpec {
    name?: string;
    owner?: string;
    /** subject -> role. A project with an owner or members lets only them authorize its sandbox apps. */
    members?: Record<string, 'owner' | 'admin' | 'developer' | 'viewer'>;
    /** '*' (default for projects declared here) or capability ids. */
    allowance?: '*' | string[];
    environmentPolicy?: 'sandbox' | 'sandbox+production';
}
export interface MockJobContext {
    input: Record<string, unknown>;
    files: Array<{ name: string; type: string; bytes: Uint8Array }>;
    progress(percent: number, message?: string | null): Promise<void>;
    readonly cancelled: boolean;
}
export interface MockToolContext {
    input: Record<string, unknown>;
    files: Array<{ name: string; type: string; bytes: Uint8Array }>;
    /** Who runs it: owner null for an anonymous caller; tier anonymous | user | service | app. */
    caller: { owner: string | null; tier: string };
    signal: AbortSignal;
}
/** An inline tool's handler returns { data } or { text } (a string is text); a job tool's handler is a job handler. */
export type MockToolHandler =
    | ((ctx: MockToolContext) => Promise<{ data?: Record<string, unknown>; text?: string } | string>)
    | ((ctx: MockJobContext) => Promise<{ data?: Record<string, unknown>; files?: Array<{ name?: string; mime?: string; bytes?: Uint8Array | string }> } | void>);
export interface MockPlatformOptions {
    origins?: Partial<Record<Origin, string>>;
    issuer?: string;
    contractsVersion?: string;
    clients?: Record<string, { secret: string; grants?: Array<MockGrant | [string, string, string[]?]>; redirectUris?: string[] }>;
    /** Developer apps by id (app_<ULID>). */
    apps?: Record<string, Omit<MockAppSpec, 'id'>>;
    /** Developer projects by id (prj_<ULID>). */
    projects?: Record<string, MockProjectSpec>;
    /** Audiences a sandbox app may get tokens for (Network DEV_SANDBOX_AUDIENCES). Default: any. */
    sandboxAudiences?: string[];
    /**
     * Audiences or capability ids whose mock services accept env=sandbox tokens (or true). Default:
     * none. Media (on /api/v1/<project_id>/files) and Events (on the events.app.* routes) accept
     * sandbox app tokens regardless, as in production.
     */
    acceptSandbox?: true | string[];
    /** Allowance of projects created through /api/v1/projects. Default: the whole catalog (Network: empty). */
    defaultAllowance?: string[];
    users?: Array<Partial<MockUser>>;
    mediaApps?: Record<string, { apiKey?: string }>;
    namespaces?: ModuleNamespace[];
    capabilities?: Capability[];
    services?: ServiceManifest[];
    realtimeRetryMs?: number;
    /** Media quotas of developer-project tenants in MB (Media's defaults: production 1024, sandbox 100). */
    mediaQuotaMb?: { production?: number; sandbox?: number };
    /** Lifetime of signed sandbox file URLs, 30..3600 s (default 300, like Media). */
    mediaSignedUrlTtlS?: number;
    /** Tools satellites that also answer /api/v1/jobs. Default: DEFAULT_TOOLS_SATELLITES. */
    toolsSatellites?: string[];
    /** Serve Tools jobs at origins.tools (the gateway facade: it also sees the satellites' jobs) and the satellites (each keeps its own jobs). */
    jobs?: boolean | { stepMs?: number; handlers?: Record<string, (ctx: MockJobContext) => Promise<{ data?: Record<string, unknown>; files?: Array<{ name?: string; mime?: string; bytes?: Uint8Array | string; data?: Uint8Array | string }> } | void>> };
    /**
     * The Tools platform API on origins.tools (implies the jobs facade there): GET /api/v1/tools[/:id[/schema]]
     * and POST /api/v1/tools/:id/run. Defaults: dns, jsonminify, png, port, yt, protectpdf.
     */
    tools?: boolean | {
        stepMs?: number;
        /** Added to the defaults; the same id replaces one. */
        descriptors?: ToolDescriptor[];
        handlers?: Record<string, MockToolHandler>;
        /** What { media_id } references read. */
        mediaObjects?: Record<string, { name?: string; type?: string; data?: Uint8Array | string }>;
    };
    /** fetch used by deliverEvents() (default: the global fetch). */
    deliveryFetch?: FetchLike;
}
export interface DeliveryAttempt { subscription_id: string; event_id: string; seq: number; attempt: number; status: number | null; outcome: 'delivered' | 'retry' | 'dead'; error?: string; }
export interface MockPlatform {
    fetch: FetchLike;
    origins: Record<Origin, string>;
    /** Every origin that answers /api/v1/jobs: origins.tools (the gateway facade) and the satellites. */
    toolsOrigins: string[];
    /** Add or replace a tool (with { tools }); returns the stored descriptor. */
    addTool(descriptor: ToolDescriptor, handler?: MockToolHandler): ToolDescriptor;
    /** A Media object that { media_id } run references read -> its med_ id. */
    addMediaObject(obj?: { id?: string; name?: string; type?: string; data?: Uint8Array | string }): string;
    issuer: string;
    keys: { privateKey: object; publicKey: object; jwks: { keys: object[]; public_key: string; algorithm: 'RS256' } };
    signUserToken(user: MockUser | string, opts?: { expiresInSec?: number; audience?: string[] }): string;
    signServiceToken(clientId: string, opts: { audience: string; capabilities?: string[]; namespaces?: string[]; expiresInSec?: number }): string;
    signAppToken(appId: string, opts: { audience: string; capabilities?: string[]; projectId?: string; env?: 'sandbox' | 'production'; onBehalfOf?: string; expiresInSec?: number }): string;
    addClient(id: string, client: { secret: string; grants?: Array<MockGrant | [string, string, string[]?]>; redirectUris?: string[] }): void;
    addUser(user?: Partial<MockUser>): MockUser;
    addApp(spec?: MockAppSpec): { id: string; clientId: string; projectId: string; env: 'sandbox' | 'production'; type: 'confidential' | 'public'; secret?: string };
    /** Returns the project id. */
    addProject(spec?: MockProjectSpec & { id?: string }): string;
    /** What the Network does after the account chooser: returns an authorization code. */
    authorize(opts: { clientId: string; redirectUri: string; subjectId?: string; codeChallenge?: string; codeChallengeMethod?: 'S256'; scope?: string | string[]; audience?: string }): string;
    /** Who GET /oauth/authorize signs in as, and whether they continue ('allow', default) or decline ('deny'). */
    setAuthorization(opts: { subjectId?: string | null; decision?: 'allow' | 'deny' }): void;
    stats: { tokenRequests: number; requests: Array<{ method: string; url: string; headers: Record<string, string> }>; deliveries: DeliveryAttempt[] };
    state: {
        /** project_id/env are set for developer-app events (null/'production' for first-party ones). */
        events: Array<{ seq: number; event: EventEnvelope; publisher: string; project_id: string | null; env: 'sandbox' | 'production' }>;
        subscriptions: Map<string, any>; modules: Map<string, any>;
        /** `${tenant}|${key}`; tenant is a Media app id, prj_… or prj_…-sandbox. */
        files: Map<string, any>;
        mediaTenants: Map<string, { id: string; project_id: string; env: 'sandbox' | 'production'; quota_bytes: number }>;
        users: Map<string, MockUser>; checkpoints: Map<string, { cursor: number; updated_at: string }>; apps: Map<string, any>; projects: Map<string, any>; jobs: Map<string, any>;
        tools: Map<string, ToolDescriptor>;
    };
    /**
     * Store an event as if published. A publisher `app:<id>` of a registered app stores it as that
     * app's event (its project and env); or pass { projectId, env }.
     */
    publishEvent(envelope: Partial<EventEnvelope> & Pick<EventEnvelope, 'event_type' | 'source' | 'actor' | 'subject'>, publisher?: string, meta?: { projectId?: string; env?: 'sandbox' | 'production' }): { event_id: string; seq: number; duplicate: boolean };
    /** Retention: drop stored events with seq <= throughSeq; returns how many. */
    pruneEvents(throughSeq: number): number;
    /** Play the Events delivery worker once (signed POSTs to subscription endpoints). */
    deliverEvents(opts?: { fetch?: FetchLike; subscriptionId?: string; timeoutMs?: number }): Promise<{ delivered: number; failed: number; dead: number; attempts: DeliveryAttempt[] }>;
    startDeliveries(opts?: { intervalMs?: number; fetch?: FetchLike; subscriptionId?: string; timeoutMs?: number }): { stop(): Promise<void> };
    dropRealtime(): void;
    dropJobStreams(): void;
}
export declare function createMockPlatform(opts?: MockPlatformOptions): MockPlatform;
export declare const DEFAULT_ORIGINS: Record<Origin, string>;
/** https://img.openvibe.tools, https://audio.openvibe.tools, https://docs.openvibe.tools */
export declare const DEFAULT_TOOLS_SATELLITES: string[];
/** Capability ids a developer app can be granted in openvibe-contracts v0.28.0 (public + active). */
export declare const DEFAULT_APP_CATALOG: string[];
