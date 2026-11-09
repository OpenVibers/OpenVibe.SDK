import type { OpenVibeClient } from './core';

/** Contracts network.link@1. */
export interface OpenVibeLink {
    id: string; name: string;
    roles: Array<'web' | 'app' | 'data' | 'media-worker' | 'ingest' | 'edge-probe' | 'edge-relay' | 'edge-cache' | 'gpu' | 'staging' | 'ci'>;
    location: { region: string; country?: string; city?: string; lat?: number; lon?: number };
    provider?: string; beacon: string;
    health: { status: 'up' | 'degraded' | 'down' | 'unknown'; checked_at: string };
    updated_at: string;
}
export interface Measured { node: OpenVibeLink; rtt_ms: number | null; ok: boolean }
export interface GeoClient {
    nodes(opts?: { role?: string; region?: string }): Promise<OpenVibeLink[]>;
    measure(nodes: OpenVibeLink[]): Promise<Measured[]>;
    nearest(opts?: { role?: string; region?: string; preferRegion?: string; list?: OpenVibeLink[] }): Promise<{ node: OpenVibeLink; rtt_ms: number | null; measured: boolean } | null>;
}
export function createGeoClient(client: OpenVibeClient, opts?: { baseUrl?: string; fetch?: typeof fetch; samples?: number; timeoutMs?: number; now?: () => number }): GeoClient;
