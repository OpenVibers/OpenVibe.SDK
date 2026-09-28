'use strict';
/** OpenRe: service-token calls with the acting subject, external_ref lookup, key rotation, null for a missing
 *  stream or session, playback cached 10 s, destinations and sessions paths, and errors kept as OpenVibeError. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient, isOpenVibeError } = require('../src/core');
const { createOpenReClient } = require('../src/openre');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

async function openre() {
    return stubServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        if (p === '/api/v1/streams' && req.method === 'GET') return send(res, 200, { streams: u.searchParams.get('external_ref') === 'live:managed_stream:12' ? [{ id: 'str_1', title: 'Slot' }] : [] });
        if (p === '/api/v1/streams' && req.method === 'POST') return send(res, 201, { stream: { id: 'str_2', title: 'New' }, key: { secret: 'shown-once' } });
        if (p === '/api/v1/streams/str_404') return send(res, 404, { type: 'about:blank', code: 'openre.not_found', status: 404 });
        if (p === '/api/v1/streams/str_1' && req.method === 'GET') return send(res, 200, { stream: { id: 'str_1' } });
        if (p === '/api/v1/streams/str_1/keys/rotate') return send(res, 200, { key: { secret: 'k2' }, ingest: { rtmp: 'rtmp://ingest/app' } });
        if (p === '/api/v1/streams/str_1/destinations' && req.method === 'POST') return send(res, 201, { destination: { id: 'dst_1' } });
        if (p === '/api/v1/destinations/dst_1/start') return send(res, 202, { ok: true });
        if (p === '/api/v1/sessions/ses_1/playback') return send(res, 200, { playback: { flv: 'http://127.0.0.1:4501/live/x.flv' } });
        if (p === '/api/v1/sessions/ses_404') return send(res, 404, { code: 'openre.not_found', status: 404 });
        if (p === '/api/v1/sessions/ses_1/end') return send(res, 409, { type: 'about:blank', code: 'openre.session_ended', status: 409, detail: 'already ended' });
        return send(res, 404, {});
    });
}

run([
    ['streams: external_ref lookup, create with the acting subject, get null on 404, rotate', async () => {
        const srv = await openre();
        const tokens = { getToken: async ({ audience }) => `tok-for-${audience}` };
        const o = createOpenReClient(createClient({ tokenProvider: tokens, baseUrls: { openre: srv.url }, retries: 0 }));
        assert.deepEqual(await o.streams.byExternalRef('live:managed_stream:12'), { id: 'str_1', title: 'Slot' });
        assert.equal(await o.streams.byExternalRef('live:managed_stream:99'), null);
        const first = srv.requests[0];
        assert.equal(first.headers.authorization, 'Bearer tok-for-openvibe.openre', 'a service token for openvibe.openre');
        assert.equal(new URL(first.url, 'http://x').searchParams.get('external_ref'), 'live:managed_stream:12');
        const made = await o.streams.create({ title: 'New' }, { subject: USR });
        assert.equal(made.stream.id, 'str_2');
        const post = srv.requests.at(-1);
        assert.equal(post.headers['x-ov-subject'], USR);
        assert.deepEqual(JSON.parse(post.body), { title: 'New' });
        assert.equal(await o.streams.get('str_404'), null);
        assert.deepEqual(await o.streams.get('str_1'), { id: 'str_1' });
        const rot = await o.streams.rotateKey('str_1', { subject: USR, graceSeconds: 30 });
        assert.equal(rot.ingest.rtmp, 'rtmp://ingest/app');
        assert.deepEqual(JSON.parse(srv.requests.at(-1).body), { grace_seconds: 30 });
        assert.equal((await o.streams.addDestination('str_1', { kind: 'rtmp', url: 'rtmp://a/b' }, { subject: USR })).id, 'dst_1');
        assert.deepEqual(await o.destinations.start('dst_1', { subject: USR }), { ok: true });
        assert.equal(o.manageUrl('str_1'), 'https://openre.stream/streams/str_1');
        await srv.close();
    }],
    ['sessions: playback is cached, a missing session is null, a refusal is an OpenVibeError', async () => {
        const srv = await openre();
        let t = 1000;
        const o = createOpenReClient(createClient({ token: 'svc', baseUrls: { openre: srv.url }, retries: 0 }), { now: () => t });
        assert.deepEqual(await o.sessions.playback('ses_1'), { flv: 'http://127.0.0.1:4501/live/x.flv' });
        await o.sessions.playback('ses_1');
        assert.equal(srv.requests.length, 1, 'cached');
        t += 10_001;
        await o.sessions.playback('ses_1');
        assert.equal(srv.requests.length, 2, 'refreshed after 10 s');
        assert.equal(await o.sessions.get('ses_404'), null);
        await assert.rejects(o.sessions.end('ses_1', { reason: 'admin' }), (err) => isOpenVibeError(err) && err.status === 409 && err.code === 'openre.session_ended');
        await srv.close();
    }],
    ['needs a core client', () => {
        assert.throws(() => createOpenReClient(null), /openvibe-sdk\/core client/);
    }],
]);
