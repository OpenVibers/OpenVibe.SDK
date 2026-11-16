// openvibe-sdk/mcp (0.176.0): the Model Context Protocol's two eras (2026-07-28 stateless; 2025-03-26 … 2025-11-25 the
// handshake) for a service's MCP server and client.

export declare const MODERN_VERSIONS: readonly string[];
export declare const LEGACY_VERSIONS: readonly string[];
export declare const DEFAULT_LEGACY: string;
export declare const META: {
    readonly protocolVersion: 'io.modelcontextprotocol/protocolVersion';
    readonly clientInfo: 'io.modelcontextprotocol/clientInfo';
    readonly clientCapabilities: 'io.modelcontextprotocol/clientCapabilities';
    readonly serverInfo: 'io.modelcontextprotocol/serverInfo';
    readonly logLevel: 'io.modelcontextprotocol/logLevel';
};
export declare const ERRORS: {
    readonly parse: -32700; readonly invalidRequest: -32600; readonly methodNotFound: -32601; readonly invalidParams: -32602; readonly internal: -32603;
    readonly headerMismatch: -32020; readonly missingRequiredClientCapability: -32021; readonly unsupportedProtocolVersion: -32022;
};
export interface RpcError { code: number; message: string; data?: unknown }
export interface Refusal { status: number; error: RpcError }
export type HeaderReader = ((name: string) => string | string[] | undefined | null) | Record<string, string | string[] | undefined>;

/** The version a 2026-07-28 request names in params._meta, or null (a handshake-era request). */
export declare function requestVersion(params: unknown): string | null;
/** null when the request may be served; else a 400 (UnsupportedProtocolVersion -32022 or HeaderMismatch -32020). */
export declare function checkRequest(opts: { header: HeaderReader; method: string; params: unknown; versions?: readonly string[]; supported?: string[] }): Refusal | null;
export declare function complete<T extends object>(result: T): T & { resultType: 'complete' };
export declare function listResult<K extends string, T>(key: K, items: T[], opts?: { ttlMs?: number; cacheScope?: 'public' | 'private'; nextCursor?: string }): { resultType: 'complete'; ttlMs: number; cacheScope: 'public' | 'private'; nextCursor?: string } & Record<K, T[]>;
export declare function discoverResult(opts: { serverInfo?: { name: string; version: string; title?: string }; capabilities?: object; instructions?: string; versions?: string[]; ttlMs?: number }): {
    resultType: 'complete'; supportedVersions: string[]; capabilities: object; instructions?: string; ttlMs: number; cacheScope: 'public'; _meta?: Record<string, unknown>;
};
export declare function methodNotFound(method: string): Refusal;
export declare function legacyVersion(asked: unknown, opts?: { supported?: readonly string[]; fallback?: string }): string;
export declare function modernRequest(opts: { id?: string | number; method: string; params?: Record<string, unknown>; version?: string; clientInfo?: { name: string; version: string }; capabilities?: object }): {
    headers: Record<string, string>; body: { jsonrpc: '2.0'; id?: string | number; method: string; params: Record<string, unknown> };
};
export declare function isComplete(result: unknown): boolean;
