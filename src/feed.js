'use strict';

/** Browser-safe reader for the public, cross-site Feed cards on OpenVibe.Community. */
function createFeedClient(client, { communityBaseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createFeedClient: pass an openvibe-sdk/core client');
    return {
        /** Read one page of cards; pass next_cursor back as cursor to continue. */
        list: ({ kind, cursor } = {}, { signal } = {}) => client.json({
            service: 'community', baseUrl: communityBaseUrl, audience: 'openvibe.community',
            path: '/api/v1/feed', query: { kind, cursor }, signal,
        }),
    };
}

module.exports = { createFeedClient };
