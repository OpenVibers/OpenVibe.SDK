'use strict';
/** Network owns experience. Reads are public; awards require network.levels.award. */
function createLevelsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createLevelsClient: pass an SDK core client');
    const call = (options) => client.json({ service: 'network', audience: 'openvibe.network', baseUrl, ...options });
    return {
        get(username, { signal } = {}) {
            if (!/^[A-Za-z0-9_]{1,40}$/.test(username)) throw new TypeError('invalid username');
            return call({ path: `/api/v1/levels/people/${encodeURIComponent(username)}`, signal });
        },
        batch(subjects, { signal } = {}) {
            if (!Array.isArray(subjects) || subjects.length > 100 || subjects.some(s => !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s))) throw new TypeError('batch requires up to 100 user subjects');
            return call({ path: `/api/v1/levels/batch?subjects=${encodeURIComponent(subjects.join(','))}`, signal });
        },
        board({ signal } = {}) { return call({ path: '/api/v1/levels/board', signal }); },
        award(body, { signal } = {}) {
            return call({ method: 'POST', path: '/internal/levels/award', json: body, signal, idempotencyKey: false });
        },
    };
}
module.exports = { createLevelsClient };
