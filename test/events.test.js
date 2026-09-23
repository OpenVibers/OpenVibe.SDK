'use strict';
/** Events: publish fills the envelope, pull cursor + gaps, subscriptions, webhook signatures. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, run } = require('./helpers');
const { createClient, parseTraceparent } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createEventsClient, verifyDelivery, signDelivery, parseDelivery } = require('../src/events');
const { createMockPlatform } = require('../src/testing');

const actor = { type: 'service', id: 'live' };

function setup() {
    const platform = createMockPlatform({
        clients: {
            live: { secret: 'live-secret', grants: [['events.event.publish', 'openvibe.events'], ['events.event.read', 'openvibe.events'], ['events.subscription.manage', 'openvibe.events']] },
            media: { secret: 'media-secret', grants: [['events.event.publish', 'openvibe.events']] },
        },
    });
    const tokens = createServiceTokenClient({ clientId: 'live', clientSecret: 'live-secret', fetch: platform.fetch });
    const client = createClient({ fetch: platform.fetch, tokenProvider: tokens });
    return { platform, client, events: createEventsClient(client, { source: 'live' }) };
}

run([
    ['publish fills event_id, timestamp, source, version, payload and trace_id', async () => {
        const { platform, events } = setup();
        const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        const out = await events.publish({ event_type: 'live.stream.started', actor, subject: { type: 'stream', id: '12' } }, { traceparent: tp });
        assert.equal(out.seq, 1);
        assert.equal(out.duplicate, false);
        const stored = platform.state.events[0].event;
        assert.match(stored.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(stored.event_id, out.event_id);
        assert.equal(stored.source, 'live');
        assert.equal(stored.version, 1);
        assert.deepEqual(stored.payload, {});
        assert.ok(!Number.isNaN(Date.parse(stored.timestamp)));
        assert.equal(stored.trace_id, '0af7651916cd43dd8448eb211c80319c');
        const call = platform.stats.requests.find((r) => r.url.endsWith('/api/v1/events') && r.method === 'POST');
        assert.equal(parseTraceparent(call.headers.traceparent).traceId, stored.trace_id, 'header and envelope agree');
        assert.equal(call.headers['idempotency-key'], stored.event_id);
        assert.match(call.headers.authorization, /^Bearer /);
    }],

    ['republishing the same event_id is a duplicate, never stored twice; batches work', async () => {
        const { platform, events } = setup();
        const env = events.prepare({ event_type: 'live.stream.ended', actor, subject: { type: 'stream', id: '1' } });
        await events.publish(env);
        const again = await events.publish(env);
        assert.equal(again.duplicate, true);
        const batch = await events.publish([
            { event_type: 'live.chat.message', actor, subject: { type: 'room', id: 'a' }, payload: { n: 1 } },
            { event_type: 'live.chat.message', actor, subject: { type: 'room', id: 'a' }, payload: { n: 2 } },
        ]);
        assert.equal(batch.results.length, 2);
        assert.equal(platform.state.events.length, 3);
        assert.throws(() => createEventsClient(createClient({ fetch: platform.fetch })).prepare({ event_type: 'x.y.z' }), TypeError, 'source required');
    }],

    ['a producer may only publish as itself', async () => {
        const { events } = setup();
        await assert.rejects(events.publish({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: '1' } }), { status: 403, code: 'events.source_mismatch' });
    }],

    ['pull + iterate walk the cursor across pages; onPage gives the durable cursor', async () => {
        const { platform, events } = setup();
        for (let i = 1; i <= 5; i++) platform.publishEvent({ event_type: i % 2 ? 'media.vod.ready' : 'live.stream.started', source: 'media', actor, subject: { type: 'vod', id: String(i) } });
        const page = await events.pull({ topic: 'media.vod.*', afterSeq: 0, limit: 2 });
        assert.deepEqual(page.events.map((e) => e.seq), [1, 3]);
        assert.equal(page.next_after_seq, 3);
        assert.equal(page.latest_seq, 5);
        const seen = [];
        const cursors = [];
        for await (const { seq, event } of events.iterate({ topic: ['media.vod.*'], afterSeq: 0, limit: 2, onPage: (p) => cursors.push(p.next_after_seq) })) {
            seen.push(seq);
            assert.equal(event.event_type, 'media.vod.ready');
        }
        assert.deepEqual(seen, [1, 3, 5]);
        assert.equal(cursors.at(-1), 5);
        assert.equal((await events.get(platform.state.events[0].event.event_id)).seq, 1);
        assert.equal(await events.get('evt_01J00000000000000000000000'), null);
        await events.setCheckpoint('media.vod.*', 5);
        assert.equal((await events.getCheckpoint('media.vod.*')).cursor, 5);
    }],

    ['iterate reports a retention gap through onGap', async () => {
        const srv = await stubServer((req, res) => {
            const after = Number(new URL(req.url, 'http://x').searchParams.get('after_seq'));
            if (after === 0) return send(res, 200, { gap: { from_seq: 1, to_seq: 9 }, events: [{ seq: 10, event: { event_type: 'a.b.c' } }], next_after_seq: 10, latest_seq: 11 });
            return send(res, 200, { events: [{ seq: 11, event: { event_type: 'a.b.c' } }], next_after_seq: 11, latest_seq: 11 });
        });
        const events = createEventsClient(createClient({ baseUrls: { events: srv.url }, token: 't' }), { source: 'live' });
        const gaps = [];
        const seqs = [];
        for await (const e of events.iterate({ topic: 'a.*', onGap: (g) => gaps.push(g) })) seqs.push(e.seq);
        assert.deepEqual(gaps, [{ from_seq: 1, to_seq: 9 }]);
        assert.deepEqual(seqs, [10, 11]);
        await srv.close();
    }],

    ['subscriptions: create (secret once), list, disable, enable', async () => {
        const { events } = setup();
        const sub = await events.subscribe({ topicPattern: 'media.vod.*', endpoint: 'http://127.0.0.1:3000/internal/events', retryPolicy: { max_attempts: 3 } });
        assert.match(sub.id, /^sub_/);
        assert.match(sub.secret, /^whsec_/);
        const list = await events.subscriptions.list();
        assert.equal(list.length, 1);
        assert.equal(list[0].secret, undefined);
        assert.equal((await events.subscriptions.disable(sub.id)).enabled, false);
        assert.equal((await events.subscriptions.enable(sub.id)).enabled, true);
        assert.equal(await events.subscriptions.get('sub_missing'), null);
        await assert.rejects(events.subscribe({ topicPattern: 'media.vod.*', endpoint: 'http://127.0.0.1:3000/internal/events' }), { status: 409, code: 'events.subscription_exists' });
    }],

    ['verifyDelivery / parseDelivery check X-OpenVibe-Signature over the raw body', async () => {
        const secret = `whsec_${'ab'.repeat(32)}`;
        const raw = Buffer.from(JSON.stringify({ event: { event_id: 'evt_1', event_type: 'media.vod.ready' }, seq: 7 }));
        const sig = signDelivery(raw, secret);
        assert.equal(sig, `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
        assert.equal(verifyDelivery(raw, sig, secret), true);
        assert.equal(verifyDelivery(raw.toString(), ` ${sig} `, secret), true);
        assert.equal(verifyDelivery(new Uint8Array(raw), sig, secret), true);
        assert.equal(verifyDelivery(raw, sig, 'other-secret'), false);
        assert.equal(verifyDelivery(Buffer.from(raw.toString().replace('7', '8')), sig, secret), false);
        assert.equal(verifyDelivery(raw, 'sha256=00', secret), false);
        assert.equal(verifyDelivery(raw, undefined, secret), false);
        assert.equal(verifyDelivery(raw, sig, ''), false);
        const d = parseDelivery(raw, { 'x-openvibe-signature': sig, 'x-openvibe-subscription-id': 'sub_1', 'x-openvibe-delivery-attempt': '2' }, secret);
        assert.deepEqual(d, { event: { event_id: 'evt_1', event_type: 'media.vod.ready' }, seq: 7, subscriptionId: 'sub_1', attempt: 2 });
        assert.equal(parseDelivery(raw, new Headers({ 'X-OpenVibe-Signature': 'sha256=bad' }), secret), null);
    }],
]);
