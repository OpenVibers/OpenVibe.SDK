import type { OpenVibeClient, Discovery, ServiceManifest, Capability, ModuleNamespace } from './core';

export interface ServiceWithHealth extends ServiceManifest {
    runtime: { status: string; http_status?: number; latency_ms?: number; checked_at: string | null; error?: string };
}
export interface RegistryClient {
    descriptor(opts?: { force?: boolean }): Promise<Discovery>;
    services(opts?: { status?: string }): Promise<ServiceWithHealth[]>;
    service(id: string): Promise<(ServiceWithHealth & { capability_details: Capability[] }) | null>;
    capabilities(opts?: { owner?: string }): Promise<Capability[]>;
    capability(id: string): Promise<Capability | null>;
    namespaces(): Promise<ModuleNamespace[]>;
    contracts(): Promise<{ version: string; contracts: Array<Record<string, unknown>> }>;
    topics(): Promise<unknown[]>;
    domain(host: string): Promise<{ domain: string; service: ServiceWithHealth } | null>;
}
export declare function createRegistryClient(client: OpenVibeClient, opts?: { baseUrl?: string }): RegistryClient;
