# openvibe-sdk/mcp

The Model Context Protocol's two eras, for a service's MCP server and its client (0.176.0).

- **2026-07-28 (stateless):** there is no initialize handshake and there are no sessions.
  - Every request names its version in `params._meta["io.modelcontextprotocol/protocolVersion"]` and in the
    `MCP-Protocol-Version` header.
  - It names its method in `Mcp-Method`. `tools/call`, `prompts/get` and `resources/read` also name their target in
    `Mcp-Name`.
  - Servers answer `server/discover`. Every result carries `resultType`, and list results carry `ttlMs` and
    `cacheScope`.
- **2025-03-26 … 2025-11-25:** the `initialize` handshake.

A server that keeps no session (all of ours) serves both on one endpoint. A request with the `_meta` version is served
the 2026-07-28 way, and an `initialize` the old way. OpenVibe.Network's gateway did it first (#1044); this module is
that, shared.

## A server

```js
const mcp = require('openvibe-sdk/mcp');

const version = mcp.requestVersion(body.params);            // null: the handshake era
if (version) {
    const bad = mcp.checkRequest({ header: (n) => req.get(n), method, params: body.params });
    if (bad) return res.status(bad.status).json({ jsonrpc: '2.0', id, error: bad.error });
    if (method === 'server/discover') return res.json({ jsonrpc: '2.0', id, result: mcp.discoverResult({ serverInfo, capabilities: { tools: {} }, instructions }) });
    if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: mcp.listResult('tools', tools, { cacheScope: 'private' }) });
    if (method === 'tools/call') return res.json({ jsonrpc: '2.0', id, result: mcp.complete(callResult) });
    const nf = mcp.methodNotFound(method);
    return res.status(nf.status).json({ jsonrpc: '2.0', id, error: nf.error });
}
// initialize: answer with mcp.legacyVersion(params.protocolVersion)
```

`checkRequest` refuses in two ways, both with HTTP 400:
- `UnsupportedProtocolVersion` `-32022`, with `data: { supported, requested }`, for a version this server does not
  speak;
- `HeaderMismatch` `-32020`, when a header disagrees with the body or is missing.

`listResult(key, items, { ttlMs, cacheScope })` returns a list result. A list that depends on the caller is `private`;
the same list for everyone is `public`.

## A client

```js
const { headers, body } = mcp.modernRequest({ id: 1, method: 'tools/call', params: { name, arguments: args }, clientInfo });
const r = await fetch(url, { method: 'POST', headers: { ...headers, Authorization: token }, body: JSON.stringify(body) });
```

A server that answers a modern request with a 400 and `-32022` (or with nothing modern) speaks only the handshake
era: fall back to `initialize`. `isComplete(result)` treats an older server's result, which has no `resultType`, as
complete.
