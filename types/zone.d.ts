/** openvibe-sdk/zone: OpenVibe.Zone — a project's object zones and their usage. */
type Opts = { signal?: AbortSignal };
type ZoneJson = Record<string, any>;
export type ZoneEnv = 'sandbox' | 'production';
export interface ZoneClient {
    zones: {
        create(project: string, req: { env: ZoneEnv; name: string; description?: string | null; quota_bytes?: number | null }, opts?: Opts & { idempotencyKey?: string }): Promise<ZoneJson>;
        list(project: string, opts?: Opts & { env?: ZoneEnv; include_deleted?: boolean; limit?: number; cursor?: string }): Promise<{ zones: ZoneJson[]; next_cursor: string | null }>;
        get(zone: string, opts?: Opts): Promise<ZoneJson>;
        update(zone: string, patch: { description?: string | null; quota_bytes?: number | null }, opts?: Opts): Promise<ZoneJson>;
        remove(zone: string, opts?: Opts & { recursive?: boolean }): Promise<ZoneJson>;
        usage(zone: string, opts?: Opts): Promise<ZoneJson>;
    };
}
export function createZoneClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): ZoneClient;
