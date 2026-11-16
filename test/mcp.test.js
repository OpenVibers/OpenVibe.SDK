'use strict';
// openvibe-sdk/mcp (0.176.0): the 2026-07-28 rules (per-request version and headers, server/discover, resultType,
// list caching) beside the handshake era, for servers and clients.
const assert = require('node:assert/strict');
const mcp = require('../src/mcp');

const V = '2026-07-28';
// A client's request, built, is exactly what a server accepts.
const call = mcp.modernRequest({ id: 3, method: 'tools/call', params: { name: 'search.web', arguments: { q: 'x' } }, clientInfo: { name: 'c', version: '1' } });
assert.equal(call.body.params._meta[mcp.META.protocolVersion], V);
assert.deepEqual(call.body.params._meta[mcp.META.clientInfo], { name: 'c', version: '1' });
assert.deepEqual([call.headers['MCP-Protocol-Version'], call.headers['Mcp-Method'], call.headers['Mcp-Name']], [V, 'tools/call', 'search.web']);
assert.equal(mcp.requestVersion(call.body.params), V);
assert.equal(mcp.checkRequest({ header: call.headers, method: 'tools/call', params: call.body.params }), null, 'a well-formed request passes');
const lower = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
assert.equal(mcp.checkRequest({ header: (n) => lower[n.toLowerCase()], method: 'tools/call', params: call.body.params }), null, 'headers read by function, any case');
assert.equal(mcp.modernRequest({ method: 'resources/read', params: { uri: 'file:///a' } }).headers['Mcp-Name'], 'file:///a');
assert.equal('id' in mcp.modernRequest({ method: 'notifications/cancelled' }).body, false, 'a notification has no id');

// Handshake-era requests name no version in _meta.
assert.equal(mcp.requestVersion({ protocolVersion: '2025-06-18' }), null);
assert.equal(mcp.requestVersion(undefined), null);

// Headers that disagree, a missing header, an unknown version.
const h = (over) => ({ ...call.headers, ...over });
let bad = mcp.checkRequest({ header: h({ 'Mcp-Method': 'tools/list' }), method: 'tools/call', params: call.body.params });
assert.deepEqual([bad.status, bad.error.code], [400, -32020]);
assert.match(bad.error.message, /Mcp-Method/);
bad = mcp.checkRequest({ header: h({ 'Mcp-Name': 'other.tool' }), method: 'tools/call', params: call.body.params });
assert.deepEqual([bad.status, bad.error.code], [400, -32020]);
const { 'MCP-Protocol-Version': _drop, ...noVersion } = call.headers;
bad = mcp.checkRequest({ header: noVersion, method: 'tools/call', params: call.body.params });
assert.deepEqual([bad.status, bad.error.code], [400, -32020], 'a missing version header is a mismatch');
const old = mcp.modernRequest({ id: 1, method: 'tools/list', version: '1900-01-01' });
bad = mcp.checkRequest({ header: old.headers, method: 'tools/list', params: old.body.params });
assert.deepEqual([bad.status, bad.error.code, bad.error.data.requested], [400, -32022, '1900-01-01']);
assert.ok(bad.error.data.supported.includes(V) && bad.error.data.supported.includes('2025-06-18'), 'the versions spoken, both eras');

// Results.
assert.deepEqual(mcp.complete({ content: [] }), { resultType: 'complete', content: [] });
assert.deepEqual(mcp.listResult('tools', [{ name: 'a' }]), { resultType: 'complete', tools: [{ name: 'a' }], ttlMs: 60000, cacheScope: 'private' });
assert.equal(mcp.listResult('prompts', [], { cacheScope: 'public', ttlMs: 5000, nextCursor: 'c2' }).nextCursor, 'c2');
assert.throws(() => mcp.listResult('tools', [], { cacheScope: 'everyone' }), /public" or "private/);
const d = mcp.discoverResult({ serverInfo: { name: 's', version: '1' }, capabilities: { tools: {} }, instructions: 'Be kind.' });
assert.deepEqual([d.resultType, d.supportedVersions[0], d.cacheScope, d._meta[mcp.META.serverInfo].name, d.instructions], ['complete', V, 'public', 's', 'Be kind.']);
assert.ok(d.supportedVersions.includes('2025-11-25'));
const nf = mcp.methodNotFound('resources/list');
assert.deepEqual([nf.status, nf.error.code], [404, -32601]);
assert.equal(mcp.isComplete({ resultType: 'input_required' }), false);
assert.equal(mcp.isComplete({ content: [] }), true, 'an older server\'s result counts as complete');

// The handshake era: the client's own version when spoken, else the default.
assert.equal(mcp.legacyVersion('2025-11-25'), '2025-11-25');
assert.equal(mcp.legacyVersion('2024-11-05'), '2025-06-18');
assert.equal(mcp.legacyVersion(undefined), '2025-06-18');
console.log('mcp: 2026-07-28 requests built and checked (version, headers), discover and list results, the handshake era kept');
