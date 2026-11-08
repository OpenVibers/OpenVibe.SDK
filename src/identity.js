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

/** Manage the authenticated person's private, verified email addresses on Network. */
function createAccountEmailsClient({ networkUrl = 'https://openvibe.network', getToken, fetchImpl = globalThis.fetch } = {}) {
    if (typeof getToken !== 'function') throw new TypeError('createAccountEmailsClient: getToken must be a function');
    if (typeof fetchImpl !== 'function') throw new TypeError('createAccountEmailsClient: fetch is not available');
    const base = String(networkUrl || '').replace(/\/+$/, '');
    if (!base) throw new TypeError('createAccountEmailsClient: networkUrl is required');
    async function request(path, { method = 'GET', body } = {}) {
        const token = await getToken();
        if (!token) throw new TypeError('createAccountEmailsClient: getToken returned no token');
        const response = await fetchImpl(`${base}/api/v1/me/emails${path}`, {
            method,
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error(data && (data.detail || data.error) || `Network email request failed (${response.status})`);
            error.status = response.status;
            error.code = data && (data.code || data.error);
            throw error;
        }
        return data;
    }
    return {
        list: () => request(''),
        add: (email) => request('', { method: 'POST', body: { email } }),
        verify: (id) => request(`/${encodeURIComponent(String(id))}/verify`, { method: 'POST' }),
        remove: (id) => request(`/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
        makePrimary: (id) => request(`/${encodeURIComponent(String(id))}/primary`, { method: 'POST' }),
    };
}

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

    /** True only when the supplied email is verified for the supplied Network user subject. */
    async function isEmailVerified({ subject, email } = {}) {
        if (typeof subject !== 'string' || !subject || typeof email !== 'string' || !email) throw new TypeError('isEmailVerified: subject and email are required');
        const result = await call({ method: 'POST', path: '/api/v1/identity/emails/verified-check', json: { subject, email }, idempotent: true });
        return result?.verified === true;
    }

    return { resolve, resolveBatch, isEmailVerified };
}

module.exports = { createIdentityClient, createAccountEmailsClient };
