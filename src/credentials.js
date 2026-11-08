'use strict';

/** The current person's AI credentials and provider balance readers (metadata only on list). */
function createCredentialsClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const call = (opts, o = {}) => client.json({ service: 'ai', baseUrl, audience: 'openvibe.ai', ...opts, signal: o.signal });
    return {
        list: (o = {}) => call({ method: 'GET', path: '/api/v1/me/credentials' }, o),
        add: (credential, o = {}) => call({ method: 'POST', path: '/api/v1/me/credentials', body: credential }, o),
        remove: (id, o = {}) => call({ method: 'DELETE', path: `/api/v1/me/credentials/${encodeURIComponent(id)}` }, o),
        balance: (id, o = {}) => call({ method: 'GET', path: `/api/v1/me/credentials/${encodeURIComponent(id)}/balance` }, o),
    };
}

module.exports = { createCredentialsClient };
