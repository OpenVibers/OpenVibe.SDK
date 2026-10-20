/** openvibe-sdk/run: OpenVibe.Run — jobs on worker nodes: submit, follow, cancel. */
type Opts = { signal?: AbortSignal };
type RunJson = Record<string, any>;
export type RunJobState = 'queued' | 'placed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export const RUN_JOB_STATES: RunJobState[];
export interface JobRequest {
    class: string; artifact?: { name: string; version: string }; args?: Record<string, unknown>; inputs?: unknown[];
    limits: { wall_ms: number; cpu_ms: number; mem_bytes: number }; ttl_ms?: number; egress?: unknown; requirements?: unknown; idempotency_key?: string;
}
export interface JobEvent { id: number | null; event: string; data: any }
export interface RunClient {
    jobs: {
        submit(req: JobRequest, opts?: Opts & { idempotencyKey?: string }): Promise<{ created: boolean; job: RunJson }>;
        list(opts?: Opts & { state?: RunJobState; limit?: number; cursor?: string }): Promise<{ jobs: RunJson[]; next_cursor: string | null }>;
        get(id: string, opts?: Opts): Promise<RunJson>;
        cancel(id: string, opts?: Opts): Promise<RunJson>;
        streamTicket(id: string, opts?: Opts): Promise<{ ticket: string; expires_at: string; expires_in: number; stream_url: string; job_id: string }>;
        events(id: string, opts?: Opts & { lastEventId?: number }): AsyncGenerator<JobEvent, void, unknown>;
    };
    forProject(project: string): RunClient;
}
export function createRunClient(client: { json(opts: Record<string, unknown>): Promise<any>; request(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string; project?: string }): RunClient;
