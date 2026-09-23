import type { OpenVibeClient } from './core';

export type ProjectRole = 'owner' | 'admin' | 'developer' | 'viewer';
export type EnvironmentPolicy = 'sandbox' | 'sandbox+production';
export interface Project {
    id: string;
    name: string;
    owner: { type: 'user'; id: string } | null;
    role: ProjectRole | null;
    environment_policy: EnvironmentPolicy;
    environments: Array<'sandbox' | 'production'>;
    allowance: string[];
    created_at: string;
    archived_at: string | null;
    counts: { members: number; apps: number };
    [field: string]: unknown;
}
export interface ProjectMember { subject: { type: 'user'; id: string }; username: string | null; display_name: string | null; role: ProjectRole; [field: string]: unknown; }
/** The secret is present only in the response that created it. */
export interface ShownOnceCredential { id: string; client_secret: string; hint: string; shown_once: true; }
export interface DeveloperApp {
    id: string;
    subject: { type: 'app'; id: string };
    project_id: string;
    name: string;
    environment: 'sandbox' | 'production';
    client_id: string;
    client_type: 'confidential' | 'public';
    redirect_uris: string[];
    created_at: string;
    revoked_at: string | null;
    /** Approved capabilities. */
    grants: string[];
    credential?: ShownOnceCredential;
    [field: string]: unknown;
}
export interface Credential { id: string; hint: string; state: 'active' | 'expiring' | 'expired' | 'revoked'; created_at: string; expires_at: string | null; revoked_at: string | null; [field: string]: unknown; }
export interface Grant { app_id: string; capability: string; audience: string; status: 'requested' | 'approved' | 'denied' | 'revoked'; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; }
export interface Quota { capability: string; limit: number; window: 'minute' | 'hour' | 'day' | 'month' | 'total'; unit: string; enforced_by: string | null; updated_at?: string; }
export interface CatalogCapability { id: string; owner: string; audience: string; visibility: string; description: string; resourceConstraints?: string[]; quotaClass?: string; }
export interface AuditEntry { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown>; [field: string]: unknown; }

export interface ProjectsClient {
    catalog(): Promise<CatalogCapability[]>;
    list(opts?: { all?: boolean }): Promise<Project[]>;
    create(input: { name: string }): Promise<Project>;
    get(project: string): Promise<Project | null>;
    update(project: string, input: { name: string }): Promise<Project>;
    archive(project: string): Promise<Project>;
    setAllowance(project: string, capabilities: string[]): Promise<{ allowance: string[]; trimmed: unknown[] }>;
    setEnvironmentPolicy(project: string, policy: EnvironmentPolicy): Promise<{ environment_policy: EnvironmentPolicy; environments: string[] }>;
    members: {
        list(project: string): Promise<ProjectMember[]>;
        add(project: string, input: { username?: string; subjectId?: string; role: Exclude<ProjectRole, 'owner'> }): Promise<ProjectMember>;
        update(project: string, subject: string, input: { role: Exclude<ProjectRole, 'owner'> }): Promise<ProjectMember>;
        remove(project: string, subject: string): Promise<null>;
    };
    apps: {
        list(project: string): Promise<DeveloperApp[]>;
        get(project: string, app: string): Promise<DeveloperApp | null>;
        create(project: string, input: { name: string; environment?: 'sandbox' | 'production'; type?: 'confidential' | 'public'; redirectUris?: string[] }): Promise<DeveloperApp>;
        update(project: string, app: string, input: { name?: string; redirectUris?: string[] }): Promise<DeveloperApp>;
        revoke(project: string, app: string): Promise<DeveloperApp>;
    };
    credentials: {
        list(project: string, app: string): Promise<Credential[]>;
        rotate(project: string, app: string, opts?: { overlapSeconds?: number }): Promise<{ credential: ShownOnceCredential; previous: Array<{ id: string; expires_at: string }> }>;
        revoke(project: string, app: string, credential: string): Promise<Credential>;
    };
    grants: {
        list(project: string, app: string): Promise<Grant[]>;
        request(project: string, app: string, capability: string): Promise<Grant>;
        approve(project: string, app: string, capability: string): Promise<Grant>;
        deny(project: string, app: string, capability: string): Promise<Grant>;
        revoke(project: string, app: string, capability: string): Promise<Grant>;
    };
    quotas: {
        list(project: string): Promise<Quota[]>;
        set(project: string, capability: string, input: { limit: number; window: Quota['window']; unit: string }): Promise<Quota>;
        delete(project: string, capability: string): Promise<null>;
    };
    audit(project: string, opts?: { before?: number; limit?: number }): Promise<{ entries: AuditEntry[]; next_before: number | null }>;
    iterateAudit(project: string, opts?: { pageSize?: number }): AsyncGenerator<AuditEntry, void, unknown>;
}
/** The client must carry a Network USER access token (token/getToken); service and app tokens get 401. */
export declare function createProjectsClient(client: OpenVibeClient, opts?: { baseUrl?: string }): ProjectsClient;
