export declare function createCodeVerifier(length?: number): string;
export declare function pkceChallenge(verifier: string): Promise<string>;
export declare function createPkcePair(length?: number): Promise<{ codeVerifier: string; codeChallenge: string; codeChallengeMethod: 'S256' }>;
export declare function createState(): string;

export interface AuthorizeOptions {
    network?: string;
    authorizeUrl?: string;
    clientId: string;
    redirectUri: string;
    scope?: string | string[];
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    /** 'none' = silent SSO; the callback carries error=login_required when there is no session. */
    prompt?: 'none';
}
export declare function buildAuthorizeUrl(opts: AuthorizeOptions): string;
export declare function startAuthorization(opts: Omit<AuthorizeOptions, 'codeChallenge' | 'codeChallengeMethod'> & { verifierLength?: number }): Promise<{ url: string; state: string; codeVerifier: string; codeChallenge: string }>;
export declare function readCallback(location: string | URL, opts?: { expectedState?: string }): { code: string; state: string };
export declare function base64url(bytes: Uint8Array): string;
