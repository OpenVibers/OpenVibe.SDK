'use strict';

/** Reader and owner controls for the signed-in person's private cross-site history. */
function createHistoryClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createHistoryClient: pass an openvibe-sdk/core client');
    const call = (opts, o = {}) => client.json({ service: 'network', baseUrl, ...opts, signal: o.signal });
    const enc = (v) => encodeURIComponent(String(v));
    return {
        /** Newest first. query accepts cursor, limit, day, site, kind and q. */
        list: (query = {}, o = {}) => call({ path: '/api/v1/history', query }, o),
        /** Search titles with PostgreSQL full text; query is natural language. */
        find: (q, { limit, ...o } = {}) => call({ path: '/api/v1/history/find', query: { q, limit } }, o),
        /** Last day or week, using titles and kinds only. */
        summary: (period = 'day', o = {}) => call({ path: '/api/v1/history/summary', query: { period } }, o),
        /** Recent rows for the signed-in person's agent; the server enforces the opt-in. */
        agentRecent: (query = {}, o = {}) => call({ path: '/api/v1/history/agents/recent', query }, o),
        settings: (patch, o = {}) => call({ method: 'PUT', path: '/api/v1/history/settings', json: patch }, o),
        remove: (id, o = {}) => call({ method: 'DELETE', path: `/api/v1/history/${enc(id)}` }, o),
        removeDay: (day, o = {}) => call({ method: 'DELETE', path: `/api/v1/history/day/${enc(day)}` }, o),
        removeSite: (site, o = {}) => call({ method: 'DELETE', path: `/api/v1/history/site/${enc(site)}` }, o),
        clear: (o = {}) => call({ method: 'DELETE', path: '/api/v1/history' }, o),
    };
}

module.exports = { createHistoryClient };
