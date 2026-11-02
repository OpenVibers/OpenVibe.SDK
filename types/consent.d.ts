/** openvibe-sdk/consent: may a purpose use these people's content? Server-side; it sends a service token. */
export type ConsentPurpose = 'ai.train' | 'data.public' | 'face.recognize' | 'app.data';
export type ConsentKind = 'streams' | 'vods' | 'clips' | 'voice' | 'chat' | 'posts' | 'pictures' | 'code';
export type ConsentFeature = 'verify' | 'find' | 'cast' | 'library';

export interface ConsentQueryOptions {
    kind?: ConsentKind;
    client?: string;
    feature?: ConsentFeature;
}

/** The network.consent.changed envelope or payload; either is accepted by onChange. */
export interface ConsentChangeEvent {
    payload?: { subject?: string; purpose?: ConsentPurpose | string; [k: string]: unknown };
    subject?: string;
    purpose?: ConsentPurpose | string;
    [k: string]: unknown;
}

export interface ConsentClientOptions {
    networkUrl: string;
    token: () => string | Promise<string>;
    ttlMs?: number;
    fetch?: typeof fetch;
    log?: { warn(...a: unknown[]): void } | null;
    timeoutMs?: number;
    now?: () => number;
}

export interface ConsentClient {
    /** True only when the person turned this purpose on; false on any doubt (network, timeout, malformed, no token). */
    allowed(subject: string, purpose: ConsentPurpose, opts?: ConsentQueryOptions): Promise<boolean>;
    /** The allowed subset of `subjects`, in input order, without duplicates; asked in batches of 500. */
    filter(subjects: string[], purpose: ConsentPurpose, opts?: ConsentQueryOptions): Promise<string[]>;
    /** Drop the cache for the change's subject and purpose (wire it to network.consent.changed); returns how many. */
    onChange(event?: ConsentChangeEvent | null): number;
    /** Answer from a map of subject → purposes, without the network; mock(null) returns to the live check. */
    mock(map?: Record<string, string[]> | null): ConsentClient;
    /** Forget every cached answer. */
    clear(): void;
}

export function createConsent(options: ConsentClientOptions): ConsentClient;
export const PURPOSES: readonly ConsentPurpose[];
export const KINDS: readonly ConsentKind[];
export const FEATURES: readonly ConsentFeature[];
export const MAX_SUBJECTS: number;
export const DEFAULT_TTL_MS: number;
export const DEFAULT_TIMEOUT_MS: number;
