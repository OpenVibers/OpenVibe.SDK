'use strict';
// openvibe-sdk/streams: the Agent Streams plan (S1) — an agent's own stream on Live. The routes, the bodies, the
// publish ticket as a bearer of its own on the desk's routes, the frame upload, and the guards the module sets before
// anything leaves the process.
const assert = require('assert');
const { createClient } = require('../src/core');
const { createStreamsClient } = require('../src/streams');
const { stubServer, send, run } = require('./helpers');

const AGS = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const TICKET = 'wpt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

(async () => {
    const server = await stubServer(async (req, res, body) => {
        const path = req.url.split('?')[0];
        if (req.method === 'POST' && path === '/api/streams/agent') {
            return send(res, 201, {
                stream: { id: AGS, owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', label: 'AI agent', state: 'idle' },
                publish: { whip_url: `https://whip.openvibe.live/whip/agent/${AGS}`, ticket: TICKET, expires_at: '2026-11-06T16:00:00.000Z' },
            });
        }
        if (req.method === 'POST' && path === `/api/streams/agent/${AGS}/ticket`) {
            return send(res, 201, { whip_url: `https://whip.openvibe.live/whip/agent/${AGS}`, ticket: TICKET, expires_at: '2026-11-06T20:00:00.000Z' });
        }
        if (req.method === 'DELETE' && path === `/api/streams/agent/${AGS}/ticket`) return send(res, 200, { revoked: true });
        if (req.method === 'GET' && path === `/api/streams/agent/${AGS}/state`) {
            return send(res, 200, { viewers: 2, encode: false, curtain: { up: false }, ends_at: null });
        }
        if (req.method === 'POST' && path === `/api/streams/agent/${AGS}/curtain`) return send(res, 200, { ok: true });
        if (req.method === 'PUT' && path === `/api/streams/agent/${AGS}/frame`) return send(res, 200, { ok: true });
        if (req.method === 'PUT' && path === `/api/streams/agent/${AGS}/visibility`) return send(res, 200, { ok: true });
        if (req.method === 'POST' && path === `/api/streams/agent/${AGS}/end`) return send(res, 200, { ok: true });
        if (req.method === 'POST' && path === `/api/streams/agent/${AGS}/view-ticket`) {
            return send(res, 201, { ticket: 'wvt_0123456789abcdefghijklmnop', expires_at: '2026-11-06T12:10:00.000Z' });
        }
        return send(res, 404, { error: 'not found', code: 'live.not_found' });
    });
    const client = createClient({ baseUrls: { live: server.url }, token: 'person-token', retries: 0 });
    const streams = createStreamsClient(client);
    const last = () => server.requests[server.requests.length - 1];

    await run([
        ['startAgentStream posts the create request and answers the stream and the publish part', async () => {
            const r = await streams.startAgentStream({
                title: 'Fixing the login page',
                task: { source: 'codes', ref: 'task_01JAB', title: 'Fix the login page', url: 'https://codes.openvibe.live/tasks/task_01JAB' },
                visibility: 'private',
                allowSites: ['https://example.com'],
            });
            assert.strictEqual(last().method, 'POST');
            assert.strictEqual(last().url, '/api/streams/agent');
            assert.deepStrictEqual(JSON.parse(String(last().body)), {
                title: 'Fixing the login page',
                task: { source: 'codes', ref: 'task_01JAB', title: 'Fix the login page', url: 'https://codes.openvibe.live/tasks/task_01JAB' },
                visibility: 'private',
                allow_sites: ['https://example.com'],
            });
            assert.strictEqual(last().headers.authorization, 'Bearer person-token', "the person's token rides along");
            assert.strictEqual(r.stream.id, AGS);
            assert.strictEqual(r.publish.ticket, TICKET);
        }],

        ['the guards run before anything leaves', async () => {
            const before = server.requests.length;
            await assert.rejects(() => streams.startAgentStream({ title: '', task: { source: 'codes', ref: 'a', title: 'b' }, visibility: 'private' }), /title/);
            await assert.rejects(() => streams.startAgentStream({ title: 'x', task: { source: 'browser', ref: 'a', title: 'b' }, visibility: 'private' }), /task source/);
            await assert.rejects(() => streams.startAgentStream({ title: 'x', task: { source: 'codes', ref: 'a', title: 'b' }, visibility: 'everyone' }), /visibility/);
            await assert.rejects(() => streams.startAgentStream({ title: 'x', task: { source: 'codes', ref: 'a', title: 'b', url: '/relative/path' }, visibility: 'private' }), /task URL/);
            await assert.rejects(() => streams.startAgentStream({ title: 'x', task: { source: 'codes', ref: 'a', title: 'b' }, visibility: 'private', allowSites: 'https://example.com' }), /allowSites/);
            await assert.rejects(() => streams.startAgentStream({ title: 'x', task: { source: 'codes', ref: 'a', title: 'b' }, visibility: 'private', allowSites: ['not a URI'] }), /allowed site/);
            await assert.rejects(() => streams.state('stream_77'), /agent stream id/);
            await assert.rejects(() => streams.setCurtain(AGS, true, 'gossip'), /curtain reason/);
            await assert.rejects(() => streams.setVisibility(AGS, 'everyone'), /visibility/);
            await assert.rejects(() => streams.postFrame(AGS, new Uint8Array(200 * 1024 + 1)), /200 KB/);
            assert.strictEqual(server.requests.length, before, 'nothing was sent');
        }],

        ['the ticket routes: renew, revoke', async () => {
            await streams.renewTicket(AGS);
            assert.deepStrictEqual([last().method, last().url], ['POST', `/api/streams/agent/${AGS}/ticket`]);
            await streams.revokeTicket(AGS);
            assert.deepStrictEqual([last().method, last().url], ['DELETE', `/api/streams/agent/${AGS}/ticket`]);
        }],

        ["the desk's routes carry the publish ticket, not the person's token", async () => {
            await streams.state(AGS, { ticket: TICKET });
            assert.strictEqual(last().headers.authorization, `Bearer ${TICKET}`);
            await streams.state(AGS);
            assert.strictEqual(last().headers.authorization, 'Bearer person-token', 'without a ticket the person\'s token is used');
        }],

        ['the state poll answers viewers, encode, curtain and ends_at', async () => {
            const s = await streams.state(AGS, { ticket: TICKET });
            assert.deepStrictEqual(s, { viewers: 2, encode: false, curtain: { up: false }, ends_at: null });
        }],

        ['the curtain goes up and comes down', async () => {
            await streams.setCurtain(AGS, true, 'password_field');
            assert.deepStrictEqual([last().method, last().url], ['POST', `/api/streams/agent/${AGS}/curtain`]);
            assert.deepStrictEqual(JSON.parse(String(last().body)), { up: true, reason: 'password_field' });
        }],

        ['a frame goes up as bytes with its own type', async () => {
            const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
            await streams.postFrame(AGS, jpeg, { ticket: TICKET });
            assert.deepStrictEqual([last().method, last().url], ['PUT', `/api/streams/agent/${AGS}/frame`]);
            assert.strictEqual(last().headers['content-type'], 'image/jpeg');
            assert.strictEqual(last().headers.authorization, `Bearer ${TICKET}`);
            assert.deepStrictEqual([...last().body], [...jpeg]);
            await streams.postFrame(AGS, jpeg, { contentType: 'image/webp' });
            assert.strictEqual(last().headers['content-type'], 'image/webp');
        }],

        ['visibility, end and the view ticket', async () => {
            await streams.setVisibility(AGS, 'unlisted');
            assert.deepStrictEqual([last().method, last().url], ['PUT', `/api/streams/agent/${AGS}/visibility`]);
            assert.deepStrictEqual(JSON.parse(String(last().body)), { visibility: 'unlisted' });
            await streams.end(AGS);
            assert.deepStrictEqual([last().method, last().url], ['POST', `/api/streams/agent/${AGS}/end`]);
            const v = await streams.viewTicket(AGS);
            assert.deepStrictEqual([last().method, last().url], ['POST', `/api/streams/agent/${AGS}/view-ticket`]);
            assert.ok(v.ticket.startsWith('wvt_'));
        }],
    ]);

    await server.close();
    console.log('openvibe-sdk/streams: the agent-stream routes, the ticket as a bearer, the frame upload and the guards');
})().catch((e) => { console.error(e); process.exit(1); });
