'use strict';
/** The menu's portable Home layout, network day counts and personal wall. Pass a user-token core client;
 * contribute() needs an app token with the person's community.pulse.contribute grant. */
function createHomeFeedClient(client, { networkBaseUrl, communityBaseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createHomeFeedClient: pass an openvibe-sdk/core client');
    const network = (opts) => client.json({ service: 'network', baseUrl: networkBaseUrl, audience: 'openvibe.network', ...opts });
    const community = (opts) => client.json({ service: 'community', baseUrl: communityBaseUrl, audience: 'openvibe.community', ...opts });
    return {
        home: {
            get: ({ signal } = {}) => network({ path: '/api/v1/me/home-screen', signal }),
            set: (layout, { signal } = {}) => network({ method: 'PUT', path: '/api/v1/me/home-screen', json: layout, signal }),
        },
        network: {
            today: ({ signal } = {}) => network({ path: '/api/v1/frame/today', auth: false, signal }),
        },
        feed: {
            list: ({ for: audience = 'me', cursor, signal } = {}) => community({ path: '/api/v1/pulse', query: { for: audience, cursor }, signal }),
            post: (text, { link, signal } = {}) => community({ method: 'POST', path: '/api/v1/me/status', json: { text, ...(link ? { link } : {}) }, idempotencyKey: false, signal }),
            contribute: (item, { signal } = {}) => community({ method: 'POST', path: '/api/v1/pulse/items', json: item, idempotencyKey: false, signal }),
        },
    };
}

module.exports = { createHomeFeedClient };
