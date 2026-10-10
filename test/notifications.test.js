'use strict';
/** Notifications: a subject resolves to Network's user id, then one push; unknown subjects are not errors. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createNotificationsClient } = require('../src/notifications');

const ANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const GONE = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';

run([
    ['push resolves the subject, then posts network.notification-push-request@1 with the Network user id', async () => {
        const srv = await stubServer((req, res, body) => {
            if (req.url.startsWith('/internal/identity/resolve')) {
                const subject = new URL(req.url, 'http://x').searchParams.get('subject_id');
                if (subject === ANA) return send(res, 200, { subject: { type: 'user', id: ANA }, network_user_id: 5, username: 'ana' });
                return send(res, 404, { type: 'about:blank', title: 'Not found', status: 404, code: 'identity.subject_not_found' });
            }
            if (req.url === '/internal/notifications/push') {
                const b = JSON.parse(body.toString());
                return send(res, 200, { ok: true, skipped: b.category === 'social' });
            }
            return send(res, 404, {});
        });
        const notifications = createNotificationsClient(createClient({ baseUrls: { network: srv.url }, token: 'svc' }));
        const out = await notifications.push({ subjectId: ANA, type: 'WATCH_TRIGGERED', title: 'Price dropped', message: '19.99', url: 'https://openvibe.watch/watches/wch_1', category: 'service', priority: 'high' });
        assert.deepEqual(out, { sent: true, skipped: false });
        const pushed = srv.requests.find((r) => r.url === '/internal/notifications/push');
        assert.equal(pushed.method, 'POST');
        assert.equal(pushed.headers.authorization, 'Bearer svc');
        assert.deepEqual(JSON.parse(pushed.body.toString()), { type: 'WATCH_TRIGGERED', title: 'Price dropped', message: '19.99', url: 'https://openvibe.watch/watches/wch_1', category: 'service', priority: 'high', user_id: 5 });
        assert.deepEqual(await notifications.push({ subjectId: ANA, title: 'x', category: 'social' }), { sent: true, skipped: true }, 'a category the person switched off is delivered-and-skipped');
        assert.deepEqual(await notifications.push({ subjectId: GONE, title: 'x' }), { sent: false, reason: 'unknown_subject' });
        const before = srv.requests.length;
        assert.deepEqual(await notifications.push({ userId: 7, title: 'direct' }), { sent: true, skipped: false });
        assert.equal(srv.requests.length, before + 1, 'a user id skips the resolve');
        await assert.rejects(notifications.push({ title: 'nobody' }), TypeError);
        await srv.close();
    }],

    ['a push Network refuses throws (the caller retries); a deleted account is unknown, not an error', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url.startsWith('/internal/identity/resolve')) return send(res, 200, { subject: { type: 'user', id: ANA }, network_user_id: 5, deleted: req.url.includes('PR') });
            return send(res, 503, { type: 'about:blank', title: 'Unavailable', status: 503, code: 'notifications.unavailable' });
        });
        const notifications = createNotificationsClient(createClient({ baseUrls: { network: srv.url }, token: 'svc' }));
        await assert.rejects(notifications.push({ subjectId: ANA, title: 'x' }), (err) => err.status === 503);
        assert.equal(srv.requests.filter((r) => r.url === '/internal/notifications/push').length, 1, 'attempted once: no automatic retry that could notify twice');
        await srv.close();
    }],
]);
