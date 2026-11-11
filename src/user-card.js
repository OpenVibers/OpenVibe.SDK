'use strict';
/** One public Network aggregate. Hidden/unavailable fields stay absent; no credentials are needed. */
function createUserCardClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createUserCardClient: pass an SDK core client');
    return {
        get(username, { signal } = {}) {
            if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(username)) throw new TypeError('invalid username');
            return client.json({ service: 'network', audience: 'openvibe.network', baseUrl,
                path: `/api/v1/people/${encodeURIComponent(username)}/card`, signal, auth: false, credentials: 'omit' });
        },
    };
}
module.exports = { createUserCardClient };
