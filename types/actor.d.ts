/** openvibe-sdk/actor: OpenVibe.Actor — tasks for AI agent systems, and a person's own agents and what they remember. */
type Opts = { signal?: AbortSignal };
type ActorJson = Record<string, any>;
export type ActorMode = 'cheapest' | 'balanced' | 'best' | 'fastest' | 'private';
export interface TaskRequest {
    task: string; mode?: ActorMode; budget?: { per_task_usd?: number; per_day_usd?: number }; agent?: string; idempotency_key?: string;
    webhooks?: Array<{ url: string; events?: string[]; secret_ref?: string }>; [k: string]: unknown;
}
export interface TaskEvent { id: number | null; event: string; data: any }
export interface ActorClient {
    agents: { list(opts?: Opts): Promise<{ agents: ActorJson[] }> };
    route(req: { task: string; mode?: ActorMode; agent?: string }, opts?: Opts): Promise<ActorJson>;
    tasks: {
        create(req: TaskRequest, opts?: Opts): Promise<ActorJson & { id: string; webhook_secret?: string }>;
        list(opts?: Opts & { limit?: number; before?: string }): Promise<{ tasks: ActorJson[]; next: string | null }>;
        get(id: string, opts?: Opts): Promise<ActorJson>;
        cancel(id: string, opts?: Opts): Promise<ActorJson>;
        events(id: string, opts?: Opts & { lastEventId?: number }): AsyncGenerator<TaskEvent, void, unknown>;
    };
    me: {
        agents: {
            list(opts?: Opts): Promise<{ agents: ActorJson[] }>;
            create(agent: Record<string, unknown>, opts?: Opts): Promise<ActorJson>;
            get(id: string, opts?: Opts): Promise<ActorJson>;
            update(id: string, patch: Record<string, unknown>, opts?: Opts): Promise<ActorJson>;
            remove(id: string, opts?: Opts): Promise<ActorJson>;
            run(id: string, req?: { input?: string }, opts?: Opts): Promise<ActorJson>;
            runs(id: string, opts?: Opts & { limit?: number; before?: string }): Promise<{ tasks: ActorJson[]; next: string | null }>;
            memory: {
                list(id: string, opts?: Opts): Promise<{ memory: ActorJson[] }>;
                add(id: string, text: string, opts?: Opts): Promise<ActorJson>;
                update(id: string, note: string, text: string, opts?: Opts): Promise<ActorJson>;
                remove(id: string, note: string, opts?: Opts): Promise<ActorJson>;
                clear(id: string, opts?: Opts): Promise<ActorJson>;
            };
        };
    };
}
export function createActorClient(client: { json(opts: Record<string, unknown>): Promise<any>; request(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): ActorClient;
