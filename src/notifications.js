'use strict';
/**
 * openvibe-sdk/notifications (server): tell a person something through OpenVibe.Network's notifications.
 * Needs a service token with network.notifications.push, plus identity.subject.resolve to address a person by subject
 * (audience openvibe.network). The routes are under /internal, served on the Network's host-internal address: pass that
 * as baseUrl (or baseUrls.network) when calling from the same host.
 *
 *   const notifications = createNotificationsClient(client);
 *   await notifications.push({ subjectId: 'usr_…', type: 'WATCH_TRIGGERED', title, message, url, category, priority, icon,
 *                              rich_content })
 *     -> { sent: true, skipped }              Network made its decision; skipped: the person switched that category off
 *     -> { sent: false, reason: 'unknown_subject' }   a subject Network does not know, or a deleted account
 *
 * The body is network.notification-push-request@1 (POST /internal/notifications/push): Network creates one notification
 * for its own user id, which push() resolves from the subject (pass { userId } when you already hold it). Anything else
 * Network refuses throws the client's OpenVibeError. The push is attempted once (Network keeps no idempotency record for
 * it): retry from your own queue, so a person is notified at least once and you decide how a lost answer is handled.
 */
const { createIdentityClient } = require('./identity');

function createNotificationsClient(client, { baseUrl } = {}) {
    const identity = createIdentityClient(client, { baseUrl });

    async function push({ subjectId, userId, ...notification } = {}) {
        let id = userId;
        if (id == null) {
            if (!subjectId) throw new TypeError('push: pass { subjectId } or { userId }');
            const who = await identity.resolve({ subjectId });
            if (!who || who.deleted || who.network_user_id == null) return { sent: false, reason: 'unknown_subject' };
            id = who.network_user_id;
        }
        const out = await client.json({
            service: 'network', baseUrl, audience: 'openvibe.network',
            method: 'POST', path: '/internal/notifications/push', json: { ...notification, user_id: id },
            // Network's push route keeps no idempotency record, so an automatic retry could notify twice: the caller owns
            // the retry (and its dedupe, e.g. one queued row per trigger), so this call is attempted once.
            retries: 0, idempotencyKey: false,
        });
        return { sent: true, skipped: Boolean(out && out.skipped) };
    }

    return { push };
}

module.exports = { createNotificationsClient };
