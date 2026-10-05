/** common.resource-name@1 (OVRN): the four segments of ovrn:<service>:<project_id>:<type>/<id>. */
export type ResourceNameParts = { service: string; project_id: string; type: string; id: string };
/** A common.resource-summary@1: one resource of any service, as a resource index lists it. */
export interface ResourceSummary {
    id: string;
    /** <service>.<type>, e.g. 'media.object', 'watch.watch'. */
    kind: string;
    service: string;
    project_id?: string;
    /** The OVRN when the authority includes it; resourceNameOf() composes one from kind/service/id anyway. */
    ovrn?: string;
    name?: string;
    state: string;
    created_at: string;
    updated_at?: string;
    owner?: unknown;
    usage?: Record<string, number>;
    links?: { self?: string; console?: string; docs?: string };
    [field: string]: unknown;
}
/** A common.resource-list-result@1 page: a page's resources and the opaque next_cursor (null at the end). */
export interface ResourceListResult { resources: ResourceSummary[]; next_cursor: string | null; }
/** A resource kind whose three-letter id prefix ADR-048 has chosen. */
export interface ResourceKind { kind: string; service: string; type: string; prefix: string; }
export type ResourceControlAction = 'create' | 'update' | 'delete' | 'start' | 'stop' | 'suspend' | 'resume'
    | 'resize' | 'rotate' | 'pair' | 'grant' | 'revoke' | 'archive';
/** A common.resource-control-request@1: create names resource_kind, every other action names resource. */
export interface ResourceControlRequest {
    action: ResourceControlAction;
    project_id: string;
    idempotency_key: string;
    resource?: string;
    resource_kind?: string;
    params?: Record<string, unknown>;
    on_behalf_of?: unknown;
    confirmation_id?: string | null;
    dry_run?: boolean;
    trace_id?: string;
}
/** A common.resource-control-result@1: the authority's outcome (refused/failed carry a problem). */
export interface ResourceControlResult {
    action: string;
    state: 'done' | 'pending' | 'refused' | 'failed';
    at: string;
    resource?: string;
    result?: Record<string, unknown>;
    confirmation_required?: { confirmation_id: string; reason: string };
    problem?: unknown;
    [field: string]: unknown;
}
/** An authority the index could not read to the end; its pages read so far are still returned. */
export interface StaleAuthority { authority: string; status: number; code: string; error: string; }
/** A bearer token, a getter, or anything with getToken() (openvibe-sdk/auth's createServiceTokenClient). */
export type ResourceToken = string | (() => string | Promise<string>) | { getToken(ctx?: { audience?: string }): Promise<string> };
export type ResourceIndexOptions = {
    authorities: string[];
    token?: ResourceToken | null;
    fetch?: import('./core').FetchLike;
    /** The per-request `limit` (default 100). */
    pageLimit?: number;
    /** The most requests in flight at once (default 4). */
    concurrency?: number;
    /** The per-request timeout (default 10000). */
    timeoutMs?: number;
};
export type ResourceListOptions = { project?: string; kind?: string; limit?: number };
export interface ResourceIndex {
    readonly authorities: string[];
    /** Every resource of every authority, merged in authority order; `stale` lists those not fully read. */
    list(opts?: ResourceListOptions): Promise<{ resources: ResourceSummary[]; stale: StaleAuthority[] }>;
    /** The same resources, one at a time. */
    iterate(opts?: ResourceListOptions): AsyncGenerator<ResourceSummary, void, unknown>;
}
export type ResourceClientOptions = {
    origin: string;
    token?: ResourceToken | null;
    fetch?: import('./core').FetchLike;
    /** The per-attempt timeout (default 10000). */
    timeoutMs?: number;
    /** Retries after the first attempt for a transient failure (default 2). */
    retries?: number;
    /** The base backoff between attempts (default 250; grows linearly). */
    retryDelayMs?: number;
};
export interface ResourceClient {
    readonly path: string;
    control(request: ResourceControlRequest, opts?: { retries?: number }): Promise<ResourceControlResult>;
}
/** The chosen resource kinds and their three-letter id prefixes (ADR-048); proposed/unchosen kinds are absent. */
export declare const RESOURCE_KINDS: readonly ResourceKind[];
/** ovrn:… -> its four segments, or null (contracts.resources.parse). */
export declare function parseResourceName(name: string): ResourceNameParts | null;
/** The four segments -> an OVRN; throws when they do not make one (contracts.resources.format). */
export declare function resourceName(parts: ResourceNameParts): string;
/** A summary's OVRN, or null when its kind/id do not compose one (contracts.resources.nameOf). */
export declare function resourceNameOf(summary: Pick<ResourceSummary, 'kind' | 'service' | 'project_id' | 'id'>): string | null;
/** One index over several authorities: fan out, follow each next_cursor, merge the pages. */
export declare function createResourceIndex(opts: ResourceIndexOptions): ResourceIndex;
/** POST a common.resource-control-request@1 to {origin}/api/v1/resources/control. */
export declare function createResourceClient(opts: ResourceClientOptions): ResourceClient;
