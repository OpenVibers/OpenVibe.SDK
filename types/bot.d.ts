import type { OpenVibeClient } from './core';

export interface ActingOptions {
    /** usr_… or gst_… (services only). */
    actingSubject?: string;
}
export type CallOptions = ActingOptions & { signal?: AbortSignal };

export interface Robot {
    id: string;
    name?: string;
    profile_id?: string;
    profile_version?: number;
    access_policy?: string;
    limits?: Record<string, unknown>;
    estop?: { latched: boolean; by: string | null; at: string | null };
    created_at?: string;
    updated_at?: string;
    [field: string]: unknown;
}
export interface Device {
    id: string;
    robot_ids?: string[];
    name?: string;
    kind?: string;
    agent_version?: string;
    drivers?: string[];
    capabilities?: Record<string, unknown>;
    last_seen?: string | null;
    revoked_at?: string | null;
    online?: boolean;
    [field: string]: unknown;
}
export interface Pairing { code: string; expires_at?: string; installer?: string; [field: string]: unknown; }
export interface Operator { subject: string; role?: string; [field: string]: unknown; }
export interface AuditEntry { id: number; robot_id?: string; device_id?: string | null; operator_subject?: string; operator_kind?: string; role?: string; kind?: string; value?: unknown; result?: string; reason?: string | null; latency_ms?: number | null; at?: string; [field: string]: unknown; }
export interface CommandInput { id: string; kind: string; value?: unknown; ms?: number; }
export interface CommandResult { robot_id: string; result: string; code?: string; reason?: string | null; [field: string]: unknown; }

export interface RobotsApi {
    list(query?: { owner?: string }, opts?: CallOptions): Promise<{ robots: Robot[] }>;
    get(id: string, opts?: CallOptions): Promise<{ robot: Robot; role: string } | null>;
    create(input: { owner?: string; name?: string; profile_id?: string; access_policy?: string; limits?: Record<string, unknown> }, opts?: CallOptions): Promise<{ robot: Robot; pairing: Pairing }>;
    update(id: string, patch: { name?: string; access_policy?: string; limits?: Record<string, unknown> }, opts?: CallOptions): Promise<{ robot: Robot }>;
    delete(id: string, opts?: CallOptions): Promise<unknown>;
    pairingCode(id: string, opts?: CallOptions): Promise<Pairing>;
    operators: {
        list(id: string, opts?: CallOptions): Promise<{ operators: Operator[] }>;
        add(id: string, input: { subject: string; role?: string }, opts?: CallOptions): Promise<{ operators: Operator[] }>;
        remove(id: string, subject: string, opts?: CallOptions): Promise<{ operators: Operator[] }>;
    };
    devices(id: string, opts?: CallOptions): Promise<{ devices: Device[] }>;
    audit(id: string, query?: { before?: number; limit?: number }, opts?: CallOptions): Promise<{ audit: AuditEntry[]; next_before: number | null }>;
    iterateAudit(id: string, query?: { before?: number; limit?: number }, opts?: CallOptions): AsyncGenerator<AuditEntry, void, unknown>;
    estop(id: string, opts?: CallOptions): Promise<{ robot: Robot }>;
    clearEstop(id: string, opts?: CallOptions): Promise<{ robot: Robot }>;
    command(id: string, input: CommandInput, opts?: CallOptions): Promise<CommandResult>;
    streaming: {
        get(id: string, opts?: CallOptions): Promise<Record<string, unknown>>;
        set(id: string, input: { to?: unknown; on?: boolean; owner?: string }, opts?: CallOptions): Promise<Record<string, unknown>>;
    };
}
export interface DevicesApi {
    rotate(id: string, opts?: CallOptions): Promise<{ device: Device; credential?: string; [field: string]: unknown }>;
    revoke(id: string, opts?: CallOptions): Promise<{ device: Device }>;
}
export interface ProfilesApi {
    list(opts?: CallOptions): Promise<{ profiles: Array<Record<string, unknown>> }>;
    get(id: string, opts?: CallOptions): Promise<{ profile: Record<string, unknown> } | null>;
}
export interface KitsApi {
    list(opts?: CallOptions): Promise<{ kits: Array<Record<string, unknown>> }>;
    get(id: string, opts?: CallOptions): Promise<{ kit: Record<string, unknown> } | null>;
}
export interface PairInput {
    code: string;
    robot?: string;
    agent_version?: string;
    device_kind?: string;
    drivers?: string[];
    capabilities?: Record<string, unknown>;
    name?: string;
}
export interface MachineCommandInput { id?: string; kind: 'exec' | 'fs' | 'screen' | 'input' | 'browser' | 'probe' | 'desk' | 'ai'; value: Record<string, unknown>; ms?: number; }
/** A machine's own models (OpenVibe.Node's ai plugin): what it offers and how fast its last model answered there. */
export interface MachineAi { models: string[]; ready: boolean; max_tokens?: number; }
export interface MachineAiSpeed { model: string; tokens_per_s: number; }
export interface Machine {
    id: string; name: string | null; online: boolean;
    agent_computer?: boolean; ai_models?: boolean; watch_probe?: boolean;
    computer: ({ ai?: MachineAi | null; ai_speed?: MachineAiSpeed | null; desks_running?: number | null; [field: string]: unknown }) | null;
    [field: string]: unknown;
}
export interface MachineChatInput { model: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; max_tokens?: number; temperature?: number; }
export interface MachineChatResult { model: string; message: { role: 'assistant'; content: string }; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; finish_reason?: string; ms?: number; }
export interface MachineCommandResult { machine_id?: string; id?: string; result: 'ack' | 'nack' | 'expired' | 'refused' | string; data?: Record<string, unknown>; code?: string; reason?: string | null; [field: string]: unknown; }
export interface DeskOptions { name?: string; kind?: 'browser' | 'desktop'; profile?: string; width?: number; height?: number; }
export interface Desk {
    readonly name: string;
    readonly machine: string;
    start(ms?: number): Promise<Record<string, unknown>>;
    stop(): Promise<Record<string, unknown>>;
    status(): Promise<Record<string, unknown>>;
    browser(value: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>;
    screen(value?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>;
    input(value: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>;
    exec(value: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>;
    turn(): Promise<{ desk: string; person_driving: boolean; last_person_at: string | null }>;
}
export interface MachinesApi {
    list(opts?: CallOptions): Promise<{ machines: Machine[] }>;
    computer(id: string, opts?: CallOptions): Promise<{ machine: Record<string, unknown> } | null>;
    command(id: string, input: MachineCommandInput, opts?: CallOptions): Promise<MachineCommandResult>;
    deskTurn(id: string, desk: string, opts?: CallOptions): Promise<{ desk: string; person_driving: boolean; last_person_at: string | null }>;
    desk(id: string, options?: DeskOptions, opts?: CallOptions): Desk;
    chat(id: string, input: MachineChatInput, opts?: CallOptions & { ms?: number }): Promise<MachineChatResult>;
    aiModels(id: string, on: boolean, opts?: CallOptions): Promise<{ machine: Machine }>;
}
export interface BotClient {
    robots: RobotsApi;
    machines: MachinesApi;
    devices: DevicesApi;
    profiles: ProfilesApi;
    kits: KitsApi;
    pair(input: PairInput, opts?: CallOptions): Promise<{ device_id: string; credential?: string; robot_id?: string; profile?: Record<string, unknown> | null; [field: string]: unknown }>;
    as(who: string | ActingOptions): BotClient;
    headers(): Record<string, string>;
}
export declare function createBotClient(client: OpenVibeClient, defaults?: ActingOptions & { baseUrl?: string }): BotClient;
export declare function actingHeaders(opts?: ActingOptions): Record<string, string>;
