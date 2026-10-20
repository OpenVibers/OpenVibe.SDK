/** openvibe-sdk/space: OpenVibe.Space — static-site deploys, projects, sites, serving settings, Git source and domains. */
type Opts = { signal?: AbortSignal };
type SpaceJson = Record<string, any>;
export type SpaceRole = 'deployer' | 'maintainer' | 'owner';
export type ArchiveBody = Uint8Array | ArrayBuffer | Blob | ReadableStream | NodeJS.ReadableStream;
export interface SiteFile { path: string; data: Blob | ArrayBuffer | Uint8Array | string; type?: string }
export interface SiteConfig { headers?: Record<string, string>; redirects?: unknown[]; spa?: boolean }
export interface UploadOpts extends Opts { activate?: boolean; preview?: boolean; root?: string }
export interface SpaceClient {
    projects: {
        list(opts?: Opts): Promise<SpaceJson>;
        create(fields: Record<string, unknown>, opts?: Opts): Promise<SpaceJson>;
        get(project: string, opts?: Opts): Promise<SpaceJson>;
        remove(project: string, opts?: Opts): Promise<SpaceJson>;
        quota(project: string, opts?: Opts): Promise<SpaceJson>;
        sites(project: string, opts?: Opts): Promise<SpaceJson>;
        members: {
            set(project: string, principal: string, role: SpaceRole, opts?: Opts): Promise<SpaceJson>;
            remove(project: string, principal: string, opts?: Opts): Promise<SpaceJson>;
        };
    };
    sites: {
        create(project: string, fields: Record<string, unknown>, opts?: Opts): Promise<SpaceJson>;
        get(site: string, opts?: Opts): Promise<SpaceJson>;
        remove(site: string, opts?: Opts): Promise<SpaceJson>;
        config: { get(site: string, opts?: Opts): Promise<SpaceJson>; set(site: string, config: SiteConfig, opts?: Opts): Promise<SpaceJson>; reset(site: string, opts?: Opts): Promise<SpaceJson> };
        source: { get(site: string, opts?: Opts): Promise<SpaceJson>; set(site: string, source: Record<string, unknown>, opts?: Opts): Promise<SpaceJson>; remove(site: string, opts?: Opts): Promise<SpaceJson> };
    };
    deploys: {
        list(site: string, opts?: Opts): Promise<SpaceJson>;
        get(deploy: string, opts?: Opts): Promise<SpaceJson>;
        log(deploy: string, opts?: Opts): Promise<SpaceJson>;
        uploadArchive(site: string, archive: ArchiveBody, opts?: UploadOpts & { gzip?: boolean }): Promise<{ deploy: SpaceJson; activated: boolean; preview?: unknown; url?: string }>;
        uploadFiles(site: string, files: SiteFile[], opts?: UploadOpts): Promise<{ deploy: SpaceJson; activated: boolean; preview?: unknown; url?: string }>;
        uploadSourceBuild(site: string, archive: ArchiveBody, opts: Opts & { ref: string; commit_sha: string; gzip?: boolean }): Promise<SpaceJson>;
        activate(deploy: string, opts?: Opts & { expected_active?: string | null }): Promise<SpaceJson>;
        rollback(site: string, opts?: Opts & { deploy_id?: string; expected_active?: string | null }): Promise<SpaceJson>;
        remove(deploy: string, opts?: Opts): Promise<SpaceJson>;
    };
    domains: {
        list(site: string, opts?: Opts): Promise<SpaceJson>;
        add(site: string, fields: Record<string, unknown>, opts?: Opts): Promise<SpaceJson>;
        verify(domain: string, opts?: Opts): Promise<SpaceJson>;
        remove(domain: string, opts?: Opts): Promise<SpaceJson>;
    };
}
export function createSpaceClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): SpaceClient;
