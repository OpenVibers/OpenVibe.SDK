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
export interface BotClient {
    robots: RobotsApi;
    devices: DevicesApi;
    profiles: ProfilesApi;
    kits: KitsApi;
    pair(input: PairInput, opts?: CallOptions): Promise<{ device_id: string; credential?: string; robot_id?: string; profile?: Record<string, unknown> | null; [field: string]: unknown }>;
    as(who: string | ActingOptions): BotClient;
    headers(): Record<string, string>;
}
export declare function createBotClient(client: OpenVibeClient, defaults?: ActingOptions & { baseUrl?: string }): BotClient;
export declare function actingHeaders(opts?: ActingOptions): Record<string, string>;
