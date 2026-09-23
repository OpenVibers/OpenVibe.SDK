'use strict';
/**
 * openvibe-sdk/identity (server): canonical subject resolution on OpenVibe.Network.
 * Needs a service token with identity.subject.resolve (audience openvibe.network). The routes are
 * under /internal, which the Network serves on its host-internal address: pass that as baseUrl
 * (or baseUrls.network) when calling from the same host.
 *
 *   GET  /internal/identity/resolve?subject_id=usr_…  |  ?system=live&type=user&id=123
 *   POST /internal/identity/resolve-batch { subject_ids } | { system, type, ids }   (<= 500 per call)
 */
const { isOpenVibeError } = require('./core/errors');

const BATCH = 500;

function createIdentityClient(client, { baseUrl } = {}) {
    const call = (opts) => client.json({ service: 'network', baseUrl, audience: 'openvibe.network', ...opts });

    /**
     * resolve({ subjectId }) | resolve({ system, type = 'user', id })
     *   -> { subject, network_user_id?, username, display_name, avatar_url, banned, legacy?… } | null
     */
    async function resolve(input = {}) {
        const query = input.subjectId ? { subject_id: input.subjectId }
            : { system: input.system, type: input.type || 'user', id: input.id != null ? String(input.id) : undefined };
        if (!query.subject_id && !(query.system && query.id)) throw new TypeError('resolve: pass { subjectId } or { system, id }');
        try {
            return await call({ path: '/internal/identity/resolve', query });
        } catch (err) {
            if (isOpenVibeError(err) && err.status === 404 && err.code === 'identity.subject_not_found') return null;
            throw err;
        }
    }

    /**
     * resolveBatch({ subjectIds }) | resolveBatch({ system, type = 'user', ids })
     *   -> { <id>: projection | null }  (any length; split into calls of 500)
     */
    async function resolveBatch(input = {}) {
        const list = input.subjectIds || input.ids;
        if (!Array.isArray(list)) throw new TypeError('resolveBatch: pass { subjectIds } or { system, ids }');
        if (!input.subjectIds && !input.system) throw new TypeError('resolveBatch: system is required with ids');
        const results = {};
        const unique = [...new Set(list.map(String))];
        for (let i = 0; i < unique.length; i += BATCH) {
            const chunk = unique.slice(i, i + BATCH);
            const json = input.subjectIds ? { subject_ids: chunk } : { system: input.system, type: input.type || 'user', ids: chunk };
            const out = await call({ method: 'POST', path: '/internal/identity/resolve-batch', json, idempotent: true });
            Object.assign(results, out && out.results);
        }
        return results;
    }

    return { resolve, resolveBatch };
}

module.exports = { createIdentityClient };
