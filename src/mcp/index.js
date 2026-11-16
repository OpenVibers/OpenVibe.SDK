'use strict';
/**
 * openvibe-sdk/mcp — the Model Context Protocol's two eras, for a service's MCP server and client (0.177.0).
 *
 * MCP 2026-07-28 is stateless: no initialize handshake and no sessions. Every request names its version in
 * params._meta["io.modelcontextprotocol/protocolVersion"] and in the MCP-Protocol-Version header, and its method in
 * Mcp-Method (tools/call, resources/read and prompts/get also their name or uri in Mcp-Name). Servers answer
 * server/discover. Results carry resultType, and list results carry ttlMs and cacheScope. 2025-03-26 … 2025-11-25 keep
 * the handshake. A stateless server serves both on one endpoint: a request with the _meta version is served the
 * 2026-07-28 way, an initialize the old way. (OpenVibe.Network's gateway did it first, #1044; this is that, shared.)
 *
 * Server:
 *   const mcp = require('openvibe-sdk/mcp');
 *   const version = mcp.requestVersion(body.params);            // null: the handshake era
 *   if (version) {
 *     const bad = mcp.checkRequest({ header: (n) => req.get(n), method, params: body.params });
 *     if (bad) return res.status(bad.status).json({ jsonrpc: '2.0', id, error: bad.error });
 *     if (method === 'server/discover') return res.json({ jsonrpc: '2.0', id, result: mcp.discoverResult({ serverInfo, capabilities, instructions }) });
 *     if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: mcp.listResult('tools', tools, { cacheScope: 'private' }) });
 *     if (method === 'tools/call') return res.json({ jsonrpc: '2.0', id, result: mcp.complete(callResult) });
 *     const nf = mcp.methodNotFound(method); return res.status(nf.status).json({ jsonrpc: '2.0', id, error: nf.error });
 *   }
 *   // initialize: mcp.legacyVersion(params.protocolVersion) is the version to answer
 *
 * Client (calling a 2026-07-28 server):
 *   const { headers, body } = mcp.modernRequest({ id: 1, method: 'tools/list', clientInfo: { name: 'openvibe-actor', version: '1' } });
 *   await fetch(url, { method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify(body) });
 *   mcp.isComplete(result)   // a result without resultType (an older server) counts as complete
 */

const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const DEFAULT_LEGACY = '2025-06-18';
const META = Object.freeze({
    protocolVersion: 'io.modelcontextprotocol/protocolVersion',
    clientInfo: 'io.modelcontextprotocol/clientInfo',
    clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
    serverInfo: 'io.modelcontextprotocol/serverInfo',
    logLevel: 'io.modelcontextprotocol/logLevel',
});
const ERRORS = Object.freeze({
    parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
    headerMismatch: -32020, missingRequiredClientCapability: -32021, unsupportedProtocolVersion: -32022,
});
// The methods whose target is also a header (Mcp-Name), and where in params it is.
const NAMED = Object.freeze({ 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' });

/** The version a 2026-07-28 request names in params._meta, or null (a handshake-era request). */
function requestVersion(params) {
    const meta = params && typeof params === 'object' && params._meta && typeof params._meta === 'object' ? params._meta : null;
    const v = meta ? meta[META.protocolVersion] : null;
    return typeof v === 'string' && v ? v : null;
}

const rpcError = (status, code, message, data) => ({ status, error: { code, message, ...(data ? { data } : {}) } });
const headerOf = (header, name) => {
    let v = null;
    try { v = typeof header === 'function' ? header(name) : header && (header[name] ?? header[name.toLowerCase()]); } catch { v = null; }
    if (Array.isArray(v)) v = v[0];
    return typeof v === 'string' ? v.trim() : null;
};

/**
 * Checks a 2026-07-28 request: a version this server speaks, and headers that agree with the body (MCP-Protocol-Version,
 * Mcp-Method, and Mcp-Name where the method names a target). → null when it may be served, else { status: 400, error }
 * (UnsupportedProtocolVersion -32022 with data { supported, requested }, or HeaderMismatch -32020).
 * `header(name)` reads a request header (Express: (n) => req.get(n)); a plain headers object works too.
 */
function checkRequest({ header, method, params, versions = MODERN_VERSIONS, supported = null } = {}) {
    const version = requestVersion(params);
    if (!version) return rpcError(400, ERRORS.invalidRequest, `the request names no protocol version in params._meta["${META.protocolVersion}"]`);
    if (!versions.includes(version)) {
        return rpcError(400, ERRORS.unsupportedProtocolVersion, 'Unsupported protocol version', { supported: supported || [...versions, ...LEGACY_VERSIONS], requested: version });
    }
    const mismatch = (name, value, body) => rpcError(400, ERRORS.headerMismatch, `Header mismatch: ${name} header value '${String(value || '')}' does not match body value '${String(body)}'`);
    const hv = headerOf(header, 'MCP-Protocol-Version');
    if (hv !== version) return mismatch('MCP-Protocol-Version', hv, version);
    const hm = headerOf(header, 'Mcp-Method');
    if (hm !== String(method || '')) return mismatch('Mcp-Method', hm, method);
    const field = NAMED[method];
    if (field) {
        const target = String((params && params[field]) || '');
        const hn = headerOf(header, 'Mcp-Name');
        if (hn !== target) return mismatch('Mcp-Name', hn, target);
    }
    return null;
}

/** A result, said to be complete (2026-07-28 asks every result for resultType). */
function complete(result) { return { resultType: 'complete', ...(result || {}) }; }

/** A list result (tools, prompts, resources …) with how long a client may keep it: private when it is this caller's. */
function listResult(key, items, { ttlMs = 60000, cacheScope = 'private', nextCursor } = {}) {
    if (cacheScope !== 'public' && cacheScope !== 'private') throw new TypeError('cacheScope is "public" or "private"');
    return { resultType: 'complete', [key]: Array.isArray(items) ? items : [], ttlMs: Math.max(0, Math.floor(Number(ttlMs) || 0)), cacheScope, ...(nextCursor ? { nextCursor } : {}) };
}

/** server/discover's result: the versions spoken (both eras by default), the capabilities and who the server is. */
function discoverResult({ serverInfo, capabilities = {}, instructions, versions = [...MODERN_VERSIONS, ...LEGACY_VERSIONS], ttlMs = 3600000 } = {}) {
    return {
        resultType: 'complete',
        supportedVersions: [...versions],
        capabilities: capabilities || {},
        ...(instructions ? { instructions: String(instructions) } : {}),
        ttlMs, cacheScope: 'public',
        ...(serverInfo ? { _meta: { [META.serverInfo]: serverInfo } } : {}),
    };
}

/** An unknown method in the 2026-07-28 era: 404 with Method not found. */
function methodNotFound(method) { return rpcError(404, ERRORS.methodNotFound, `Method not found: ${String(method || '')}`); }

/** The version to answer a handshake-era initialize with: the client's own when this server speaks it, else the default. */
function legacyVersion(asked, { supported = LEGACY_VERSIONS, fallback = DEFAULT_LEGACY } = {}) {
    const a = String(asked || '');
    return supported.includes(a) ? a : fallback;
}

/** A 2026-07-28 request, built: the JSON-RPC body with its _meta and the headers that must agree with it. */
function modernRequest({ id, method, params = {}, version = MODERN_VERSIONS[0], clientInfo, capabilities = {} } = {}) {
    const meta = { ...(params._meta || {}), [META.protocolVersion]: version, [META.clientCapabilities]: capabilities };
    if (clientInfo) meta[META.clientInfo] = clientInfo;
    const body = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params: { ...params, _meta: meta } };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method };
    const field = NAMED[method];
    if (field && params[field] != null) headers['Mcp-Name'] = String(params[field]);
    return { headers, body };
}

/** A result is complete unless it says it needs input (an older server's result, without resultType, is complete). */
function isComplete(result) { return !result || result.resultType === undefined || result.resultType === 'complete'; }

module.exports = {
    MODERN_VERSIONS, LEGACY_VERSIONS, DEFAULT_LEGACY, META, ERRORS,
    requestVersion, checkRequest, complete, listResult, discoverResult, methodNotFound, legacyVersion, modernRequest, isComplete,
};
