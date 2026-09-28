import type { OpenVibeClient } from './core';

/** Contracts openre.stream@1 (abridged; see openvibe-contracts for the full shape). */
export interface OpenReStream {
    id: string; title: string; owner_subject?: string; state?: string;
    recording_mode?: string; recording_visibility?: string; mirror_to_live?: boolean;
    external_refs?: Array<{ service: string; type: string; id: string; label?: string | null }>;
    ingest?: Record<string, unknown>;
    [field: string]: unknown;
}
export interface OpenReSession { id: string; stream_id: string; state: string; started_at?: string; ended_at?: string | null; [field: string]: unknown }
export interface OpenReDestination { id: string; stream_id: string; kind?: string; enabled?: boolean; [field: string]: unknown }
export interface Acting { subject?: string }

export interface OpenReClient {
    streams: {
        list(opts?: Acting & { externalRef?: string; limit?: number; cursor?: string }): Promise<{ streams: OpenReStream[]; next_cursor?: string | null }>;
        byExternalRef(externalRef: string, opts?: Acting): Promise<OpenReStream | null>;
        create(body: Record<string, unknown>, opts?: Acting & { idempotencyKey?: string }): Promise<{ stream: OpenReStream; key?: unknown }>;
        get(id: string, opts?: Acting): Promise<OpenReStream | null>;
        update(id: string, patch: Record<string, unknown>, opts?: Acting): Promise<OpenReStream>;
        delete(id: string, opts?: Acting): Promise<unknown>;
        keys(id: string, opts?: Acting): Promise<unknown>;
        rotateKey(id: string, opts?: Acting & { graceSeconds?: number }): Promise<Record<string, unknown>>;
        destinations(id: string, opts?: Acting): Promise<OpenReDestination[]>;
        addDestination(id: string, body: Record<string, unknown>, opts?: Acting): Promise<OpenReDestination>;
    };
    destinations: {
        update(id: string, patch: Record<string, unknown>, opts?: Acting): Promise<OpenReDestination>;
        delete(id: string, opts?: Acting): Promise<unknown>;
        test(id: string, opts?: Acting): Promise<{ ok: boolean; detail?: string; [k: string]: unknown }>;
        start(id: string, opts?: Acting): Promise<unknown>;
        stop(id: string, opts?: Acting): Promise<unknown>;
        logs(id: string, opts?: Acting & { limit?: number }): Promise<unknown>;
    };
    sessions: {
        list(opts?: Acting & { streamId?: string; state?: string; limit?: number; cursor?: string }): Promise<{ sessions: OpenReSession[]; next_cursor?: string | null }>;
        get(id: string, opts?: Acting): Promise<OpenReSession | null>;
        playback(id: string): Promise<Record<string, unknown> | null>;
        end(id: string, opts?: Acting & { reason?: string }): Promise<unknown>;
        outputs(id: string, opts?: Acting): Promise<unknown[]>;
    };
    outputLogs(id: string, opts?: Acting & { limit?: number }): Promise<unknown>;
    workers(): Promise<unknown>;
    manageUrl(streamId: string): string;
    clearCache(): void;
}
export function createOpenReClient(client: OpenVibeClient, opts?: { baseUrl?: string; publicUrl?: string; playbackTtlMs?: number; now?: () => number }): OpenReClient;
