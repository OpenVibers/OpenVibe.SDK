export interface CredentialMetadata {
    id: string;
    kind: 'api_key' | 'admin_key' | 'session_cookie';
    provider: string;
    label?: string;
    created?: string;
    last_used?: string | null;
    expires?: string | null;
    expired?: boolean;
}
export interface SessionCookieInput {
    kind?: 'session_cookie';
    provider: 'anthropic' | 'openai';
    cookie: string;
    label?: string;
    expires_at?: string;
    /** Anthropic organization identifier; not a secret. */
    org_id?: string;
}
export interface ApiKeyInput { kind?: 'api_key'; provider: string; key: string; label?: string; base_url?: string; }
export interface CredentialsClient {
    list(options?: { signal?: AbortSignal }): Promise<{ credentials: CredentialMetadata[] }>;
    add(credential: SessionCookieInput | ApiKeyInput, options?: { signal?: AbortSignal }): Promise<{ credential: CredentialMetadata }>;
    remove(id: string, options?: { signal?: AbortSignal }): Promise<void>;
    balance(id: string, options?: { signal?: AbortSignal }): Promise<{ balance: { credential: CredentialMetadata; source: string; at: string; values: Record<string, unknown> } }>;
}
export function createCredentialsClient(client: unknown, defaults?: { baseUrl?: string }): CredentialsClient;
