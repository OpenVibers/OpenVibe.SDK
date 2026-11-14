'use strict';
/**
 * openvibe-sdk/friends: the friend circle on OpenVibe.Network (contracts network.friend-circle@1 and
 * network.friend-subjects@1; plan §AB.51 — one friend system across every site).
 *
 * Adding is one direction at a time: two people are friends when both have added each other. The
 * person's own read (network.friend-circle@1) is the whole picture in one call — mutual (friends),
 * requests (they added you, you did not), asked (you added them, they did not).
 *
 *   person   GET    /api/v1/me/friends                  the circle
 *            PUT    /api/v1/me/friends/:who             add (201 new, 200 already added)
 *            POST   /api/v1/me/friends/:who/accept      add them back (a request accepted)
 *            DELETE /api/v1/me/friends/:who             remove them
 *   service  GET    /internal/friends?subject=usr_…     the person's mutual friends as subjects only
 *                                               (network.friends.read; never grantable to apps)
 *
 * The person's own calls need their own token (list, add, accept, remove); subjects() needs a service
 * token holding network.friends.read. Browser-safe.
 */
const enc = encodeURIComponent;

/** The path segment a call names: a usr_ subject or a username. */
function who(subjectOrUsername) {
    const s = String(subjectOrUsername == null ? '' : subjectOrUsername).trim();
    if (!s) throw new TypeError('friends: pass a usr_ subject or a username');
    return enc(s);
}

function createFriendsClient(client, { baseUrl } = {}) {
    const call = (opts) => client.json({ service: 'network', baseUrl, audience: 'openvibe.network', ...opts });

    return {
        /**
         * The person's circle (network.friend-circle@1):
         * { subject, friends, mutual, requests, asked } — each person with a name, a picture and
         * whether they are on an OpenVibe site now.
         */
        list: () => call({ path: '/api/v1/me/friends' }),

        /** Add someone (a usr_ subject or a username). 201 when it is new, 200 when it was already added. */
        add: (subjectOrUsername) => call({ method: 'PUT', path: `/api/v1/me/friends/${who(subjectOrUsername)}` }),

        /** Accept a request: add them back (they added you first). */
        accept: (subjectOrUsername) => call({ method: 'POST', path: `/api/v1/me/friends/${who(subjectOrUsername)}/accept` }),

        /** Remove them again. */
        remove: (subjectOrUsername) => call({ method: 'DELETE', path: `/api/v1/me/friends/${who(subjectOrUsername)}` }),

        /**
         * A service reads a person's mutual friends as subjects only (network.friend-subjects@1):
         * { subject, friends }. Never names, never the one-sided requests. Needs network.friends.read.
         */
        subjects: (subject) => call({ path: '/internal/friends', query: { subject } }),
    };
}

module.exports = { createFriendsClient };
