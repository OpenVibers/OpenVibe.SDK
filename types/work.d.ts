/** openvibe-sdk/work: OpenVibe.Work — the job board, its sources, saved searches and tracked applications. */
type Opts = { signal?: AbortSignal };
type WorkJson = Record<string, any>;
export type ApplicationStatus = 'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn';
export const WORK_APPLICATION_STATUSES: ApplicationStatus[];
export interface ApplicationFields {
    listing_id?: string; title?: string; company?: string; url?: string; status?: ApplicationStatus; notes?: string;
    applied_at?: string | null; next_step?: string; next_step_at?: string | null;
}
export interface WorkClient {
    jobs: {
        search(opts?: Opts & { q?: string; remote?: boolean; type?: string; location?: string; limit?: number; cursor?: string }): Promise<{ jobs: WorkJson[]; next: string | null; count: number; filters: WorkJson; facets: WorkJson; sources: WorkJson[] }>;
        get(id: string, opts?: Opts): Promise<WorkJson>;
    };
    sources(opts?: Opts): Promise<{ sources: WorkJson[]; cadence_hours: number; retention_days: number }>;
    savedSearches: {
        list(opts?: Opts): Promise<{ saved_searches: WorkJson[] }>;
        create(req: { q?: string; remote?: boolean; type?: string; location?: string }, opts?: Opts): Promise<WorkJson>;
        remove(id: string, opts?: Opts): Promise<unknown>;
    };
    applications: {
        list(opts?: Opts & { status?: ApplicationStatus; limit?: number; cursor?: string }): Promise<{ applications: WorkJson[]; next: string | null }>;
        create(fields: ApplicationFields, opts?: Opts): Promise<WorkJson>;
        get(id: string, opts?: Opts): Promise<WorkJson>;
        update(id: string, patch: ApplicationFields, opts?: Opts): Promise<WorkJson>;
        remove(id: string, opts?: Opts): Promise<unknown>;
        assist(id: string, req?: { ask?: string }, opts?: Opts): Promise<{ task_id: string; task_url: string }>;
    };
}
export function createWorkClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): WorkClient;
