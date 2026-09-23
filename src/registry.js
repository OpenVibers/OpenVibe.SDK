'use strict';
/**
 * openvibe-sdk/registry: the ecosystem registry on OpenVibe.Network (/api/v1/registry), built from
 * openvibe-contracts manifests. Public, cacheable, no token. Browser-safe.
 *
 *   const registry = createRegistryClient(client);
 *   await registry.services({ status: 'alpha' });
 *   await registry.domain('openvibe.media');   // which service answers for a host
 */
const { isOpenVibeError } = require('./core/errors');

function createRegistryClient(client, { baseUrl } = {}) {
    const get = (path, query) => client.json({ service: 'network', baseUrl, path: `/api/v1/registry${path}`, query, auth: false });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });

    return {
        /** The platform descriptor (cached by the client): origins, endpoints, contracts version. */
        descriptor: (opts) => client.discover(opts),
        /** Service manifests with polled runtime health. */
        async services({ status } = {}) { return (await get('/services', { status })).services; },
        /** One manifest (+ capability_details), or null. */
        service: (id) => orNull(get(`/services/${encodeURIComponent(id)}`)),
        async capabilities({ owner } = {}) { return (await get('/capabilities', { owner })).capabilities; },
        capability: (id) => orNull(get(`/capabilities/${encodeURIComponent(id)}`)),
        async namespaces() { return (await get('/namespaces')).namespaces; },
        /** { version, contracts: [catalog entries] } */
        contracts: () => get('/contracts'),
        async topics() { return (await get('/topics')).topics; },
        /** { domain, service } for a host name, or null. */
        domain: (host) => orNull(get(`/domains/${encodeURIComponent(String(host).toLowerCase())}`)),
    };
}

module.exports = { createRegistryClient };
