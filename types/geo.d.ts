import type { OpenVibeClient } from './core';

/** Contracts network.node@1. */
export interface OpenVibeNode {
    id: string; name: string;
    roles: Array<'web' | 'app' | 'data' | 'media-worker' | 'ingest' | 'edge-probe' | 'edge-relay' | 'edge-cache' | 'gpu' | 'staging' | 'ci'>;
    location: { region: string; country?: string; city?: string; lat?: number; lon?: number };
    provider?: string; beacon: string;
    health: { status: 'up' | 'degraded' | 'down' | 'unknown'; checked_at: string };
    updated_at: string;
}
export interface Measured { node: OpenVibeNode; rtt_ms: number | null; ok: boolean }
export interface GeoClient {
    nodes(opts?: { role?: string; region?: string }): Promise<OpenVibeNode[]>;
    measure(nodes: OpenVibeNode[]): Promise<Measured[]>;
    nearest(opts?: { role?: string; region?: string; preferRegion?: string; list?: OpenVibeNode[] }): Promise<{ node: OpenVibeNode; rtt_ms: number | null; measured: boolean } | null>;
}
export function createGeoClient(client: OpenVibeClient, opts?: { baseUrl?: string; fetch?: typeof fetch; samples?: number; timeoutMs?: number; now?: () => number }): GeoClient;
