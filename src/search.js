'use strict';
/**
 * openvibe-sdk/search: OpenVibe.Search's query API (roadmap WS-F task 4). Browser-safe.
 *
 *   const search = createSearchClient(client);
 *   const { results, next_cursor } = await search.query('forum', { owner: 'community', type: 'thread' });
 *   for await (const doc of search.iterate('minecraft', { owner: 'live' })) { … }
 *   const { suggestions } = await search.suggest('japan');
 *   const doc = await search.document('live', 'channel', '327');   // null when missing or not yours to see
 *
 * The Search Fabric (Contracts 0.225.0, search.fabric.query; also the MCP tool openvibe.search): one query over
 * several scopes, routed the cheapest way that answers.
 *   const r = await search.fabric('surf maps', { scopes: ['network', 'web'], freshness: 'month', depth: 'standard' });
 *   // r: { results (each with scope, kind document|page, url, provider for the web), groups, citations,
 *   //      route: { explain, cost_usd }, next_cursor } — query(text, { scopes }) is the same call
 *   const { providers } = await search.providers();   // the web ladder's offers (price, availability, today's use)
 * Anonymous callers get the index, the open index and cached web answers; a person or a service also reaches the
 * paid providers within OpenVibe's daily caps; `mine` needs a person (actingSubject for a service).
 *
 * Who sees what is decided by Search for every hit: anonymous callers get public, published, indexable
 * documents only; a signed-in person (Bearer user JWT, or the ov_token cookie with credentials) also
 * gets restricted documents whose ACL names them; a first-party service with search.query.delegate may
 * say who it asks for (actingSubject → X-OV-Subject). Nothing returns a total count.
 *
 * Filters: owner, type, lang, facets ({ key: value | [values] } → facet.<key>=), and `facets` (the
 * facet keys to count, over what the caller can see).
 */
const { isOpenVibeError } = require('./core/errors');
const { isActingSubjectId } = require('./core/ids');

const enc = encodeURIComponent;
const FABRIC_KEYS = ['freshness', 'depth', 'limit', 'cursor', 'owner', 'type', 'lang', 'site'];

/** The query string of GET /api/v1/query (search.fabric-request@1, GET form: scopes comma-separated). */
function fabricOf(text, o = {}) {
    const q = { q: String(text == null ? '' : text) };
    const scopes = Array.isArray(o.scopes) ? o.scopes : o.scopes ? String(o.scopes).split(',') : ['network'];
    q.scopes = scopes.map((x) => String(x).trim()).filter(Boolean).join(',');
    for (const k of FABRIC_KEYS) if (o[k] !== undefined && o[k] !== null && o[k] !== '') q[k] = o[k];
    if (o.answer) q.answer = 'true';
    return q;
}
const FACET_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function queryOf(text, o = {}) {
    const q = {};
    if (text !== undefined && text !== null) q.q = String(text);
    for (const k of ['owner', 'type', 'lang', 'limit', 'cursor']) if (o[k] !== undefined && o[k] !== null) q[k] = o[k];
    if (o.facets) {
        const keys = Array.isArray(o.facets) ? o.facets : String(o.facets).split(',');
        q.facets = keys.map((k) => String(k).trim()).filter(Boolean).join(',');
    }
    for (const [k, v] of Object.entries(o.filter || {})) {
        if (!FACET_KEY.test(k)) throw new TypeError(`facet key ${k} is malformed`);
        if (v === undefined || v === null) continue;
        q[`facet.${k}`] = Array.isArray(v) ? v.map(String) : String(v);
    }
    return q;
}

// Repeated keys for several values of one facet (facet.tags=a&facet.tags=b): Search reads each as a
// value, where the core client's comma join would make one value 'a,b'.
function pathWith(path, q) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) for (const one of Array.isArray(v) ? v : [v]) qs.append(k, String(one));
    const s = qs.toString();
    return s ? `${path}?${s}` : path;
}

function createSearchClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    function call(opts, perCall = {}) {
        const acting = perCall.actingSubject !== undefined ? perCall.actingSubject : defaults.actingSubject;
        const headers = { ...opts.headers };
        if (acting) {
            if (!isActingSubjectId(acting)) throw new TypeError('actingSubject must be a usr_… or gst_… subject id');
            headers['X-OV-Subject'] = acting;
        }
        return client.json({ service: 'search', baseUrl, audience: 'openvibe.search', ...opts, headers, signal: perCall.signal });
    }
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });

    /** The Search Fabric: GET, so the core client may retry it safely. */
    const fabric = (text, o = {}) => call({ path: pathWith('/api/v1/query', fabricOf(text, o)) }, o);
    return {
        /** { results, next_cursor, facets? } — one page. With `scopes`, the Search Fabric (fabric()). */
        query: (text, o = {}) => (o.scopes ? fabric(text, o) : call({ path: pathWith('/api/v1/search', queryOf(text, o)) }, o)),
        /** search.fabric-result@1 — one query over network, mine, web and the vertical scopes. */
        fabric,
        /** { providers: search.provider-offer@1[] } — the web ladder's providers. */
        providers: (o = {}) => call({ path: '/api/v1/query/providers' }, o),
        /** Every result, page after page (cursor), until Search has no more or `max` is reached. */
        async *iterate(text, o = {}) {
            let cursor = o.cursor || null;
            let seen = 0;
            const max = Number.isFinite(o.max) ? o.max : Infinity;
            do {
                const page = await call({ path: pathWith('/api/v1/search', queryOf(text, { ...o, cursor })) }, o);
                for (const r of page.results || []) { if (seen++ >= max) return; yield r; }
                cursor = page.next_cursor || null;
            } while (cursor);
        },
        /** { suggestions: [{ owner, type, id, title, canonical_url }] } — titles starting with what was typed. */
        suggest: (text, o = {}) => call({ path: pathWith('/api/v1/suggest', queryOf(text, { owner: o.owner, type: o.type, limit: o.limit })) }, o),
        /** One document by exact id, or null (a document you may not see answers the same as a missing one). */
        document: (owner, type, id, o = {}) => orNull(call({ path: `/api/v1/documents/${enc(owner)}/${enc(type)}/${enc(id)}` }, o)),
    };
}

module.exports = { createSearchClient, queryOf, fabricOf };
