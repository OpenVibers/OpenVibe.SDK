'use strict';
/**
 * openvibe-sdk/wiki — OpenVibe.Wiki for apps: search pages and read them (the revision the person may read, its history,
 * diffs and citations), and list the spaces. Routes at https://openvibe.wiki/api/v1; tokens for audience
 * openvibe.wiki. A developer app acts only for the person who authorized it (on_behalf_of); without a person, only
 * public, published pages are visible.
 *
 *   const wiki = createWikiClient(createClient({ tokenProvider }));
 *   const { results } = await wiki.search('restreaming', { space: 'openvibe', limit: 5 });
 *   const page = await wiki.pages.get(results[0].id);                         // the published revision
 *   const { revisions } = await wiki.pages.revisions(results[0].id, { limit: 10 });
 *   const diff = await wiki.pages.diff(results[0].id, { from: 3, to: 4 });
 *
 * Capabilities (public since openvibe-contracts 0.207.0): wiki.page.read and wiki.search.query. Writing pages stays
 * with people on openvibe.wiki and first-party services. Errors are OpenVibeError: page.not_found, space.not_found,
 * revision.not_found, capability.denied, subject.not_delegated, …
 */
const enc = encodeURIComponent;
const PAGE_ID_RE = /^pg_[0-9A-HJKMNP-TV-Z]{26}$/;   // the Wiki's own rule

function createWikiClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createWikiClient: pass an openvibe-sdk/core client');
    const at = { service: 'wiki', baseUrl, audience: 'openvibe.wiki' };
    const call = (opts) => client.json({ ...at, ...opts });
    const page = (id, rest = '') => {
        if (!PAGE_ID_RE.test(String(id || ''))) throw new TypeError('wiki: a page is a pg_ id');
        return `/api/v1/pages/${enc(String(id))}${rest}`;
    };
    const rev = (n) => {
        if (!Number.isInteger(Number(n)) || Number(n) < 1) throw new TypeError('wiki: a revision number');
        return Number(n);
    };

    return {
        /** Published pages matching q that the person may read: { results }. */
        search: (q, { space, limit, signal } = {}) => {
            if (typeof q !== 'string' || !q.trim()) throw new TypeError('wiki.search: the words to search for');
            return call({ path: '/api/v1/search', query: { q, space, limit }, signal });
        },
        spaces: {
            list: ({ signal } = {}) => call({ path: '/api/v1/spaces', signal }),
            /** A space and its page tree. */
            get: (space, { signal } = {}) => call({ path: `/api/v1/spaces/${enc(String(space))}`, signal }),
        },
        pages: {
            /** A page and the revision the person may read (a given revision with { revision }). */
            get: (id, { revision, signal } = {}) => call({ path: page(id), query: { revision: revision == null ? undefined : rev(revision) }, signal }),
            revisions: (id, { before, limit, signal } = {}) => call({ path: page(id, '/revisions'), query: { before, limit }, signal }),
            revision: (id, n, { signal } = {}) => call({ path: page(id, `/revisions/${rev(n)}`), signal }),
            diff: (id, { from, to, mode, signal } = {}) => call({ path: page(id, '/diff'), query: { from: rev(from), to: rev(to), mode }, signal }),
            citations: (id, n, { signal } = {}) => call({ path: page(id, `/revisions/${rev(n)}/citations`), signal }),
        },
    };
}

module.exports = { createWikiClient };
