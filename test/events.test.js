'use strict';
/** Events: publish fills the envelope, pull cursor + gaps, subscriptions, webhook signatures. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, run, waitFor } = require('./helpers');
const { createClient, parseTraceparent } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createEventsClient, verifyDelivery, signDelivery, parseDelivery, createInbox, verifyDeliveryV2, signDeliveryV2, signDeliveryHeaders } = require('../src/events');
const { subscribe } = require('../src/realtime');
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

    ['verifyDeliveryV2 checks X-OpenVibe-Signature-V2 (HMAC of "<t>.<raw body>") and the ±300 s window', async () => {
        const secret = `whsec_${'ab'.repeat(32)}`;
        const raw = Buffer.from(JSON.stringify({ event: { event_id: 'evt_1', event_type: 'media.vod.ready' }, seq: 7 }));
        const now = 1790000000000;
        const t = now / 1000;
        const v2 = signDeliveryV2(raw, secret, t);
        assert.equal(v2, `t=${t},v2=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`);
        const headers = { 'x-openvibe-timestamp': String(t), 'x-openvibe-signature-v2': v2 };
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now }), true);
        assert.equal(verifyDeliveryV2(raw.toString(), new Headers(headers), secret, { now }), true, 'Fetch Headers, string body');
        assert.equal(verifyDeliveryV2(new Uint8Array(raw), { 'X-OpenVibe-Signature-V2': v2 }, secret, { now }), true, 'any header case; X-OpenVibe-Timestamp optional');
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now: now + 300000 }), true, 'edge of the window');
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now: now - 300000 }), true);
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now: now + 300001 }), false, 'too old: a replay');
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now: now - 300001 }), false, 'too far in the future');
        assert.equal(verifyDeliveryV2(raw, headers, secret, { now: now + 600000, toleranceSec: 600 }), true, 'toleranceSec');
        assert.equal(verifyDeliveryV2(raw, headers, secret), false, 'defaults to Date.now()');
        assert.equal(verifyDeliveryV2(raw, headers, 'other-secret', { now }), false);
        assert.equal(verifyDeliveryV2(Buffer.from(raw.toString().replace('7', '8')), headers, secret, { now }), false, 'body changed');
        assert.equal(verifyDeliveryV2(raw, { ...headers, 'x-openvibe-signature-v2': v2.replace(`t=${t}`, `t=${t + 1}`) }, secret, { now }), false, 'timestamp changed');
        assert.equal(verifyDeliveryV2(raw, { ...headers, 'x-openvibe-timestamp': String(t - 1) }, secret, { now }), false, 'X-OpenVibe-Timestamp disagrees with t');
        assert.equal(verifyDeliveryV2(raw, { 'x-openvibe-signature-v2': `${v2},v2=${'0'.repeat(64)}` }, secret, { now }), true, 'one of several v2 values');
        const mac = v2.split(',')[1];
        for (const bad of [undefined, '', mac, `t=${t}`, `t=${t},t=${t},${mac}`, `t=-${t},${mac}`, `t=${t}.5,${mac}`, `t=${t},v2=00`, `t=${t},${mac}x`, signDelivery(raw, secret)]) {
            assert.equal(verifyDeliveryV2(raw, { 'x-openvibe-signature-v2': bad }, secret, { now }), false, String(bad));
        }
        assert.equal(verifyDeliveryV2(raw, headers, '', { now }), false);
        assert.equal(verifyDeliveryV2(null, headers, secret, { now }), false);
        assert.throws(() => verifyDeliveryV2(raw, headers, secret, { toleranceSec: -1 }), TypeError);
        assert.throws(() => signDeliveryV2(raw, secret, 1.5), TypeError);
        assert.match(signDeliveryV2(raw, secret), /^t=\d{10},v2=[0-9a-f]{64}$/, 'defaults to now');
        const all = signDeliveryHeaders(raw, secret, { now: now + 999 });
        assert.deepEqual(all, { 'X-OpenVibe-Signature': signDelivery(raw, secret), 'X-OpenVibe-Timestamp': String(t), 'X-OpenVibe-Signature-V2': v2 });
    }],

    ['parseDelivery: a present v2 must verify and be fresh (no v1 fallback); requireV2 refuses v1-only', async () => {
        const secret = `whsec_${'cd'.repeat(32)}`;
        const raw = Buffer.from(JSON.stringify({ event: { event_id: 'evt_2', event_type: 'media.vod.ready' }, seq: 9 }));
        const now = 1790000000000;
        const signed = signDeliveryHeaders(raw, secret, { now });
        const want = { event: { event_id: 'evt_2', event_type: 'media.vod.ready' }, seq: 9, subscriptionId: null, attempt: 1 };
        const v1only = { 'x-openvibe-signature': signed['X-OpenVibe-Signature'] };
        // Both headers (what Events sends): v2 decides.
        assert.deepEqual(parseDelivery(raw, signed, secret, { now }), want);
        assert.deepEqual(parseDelivery(raw, signed, secret, { now, requireV2: true }), want);
        assert.deepEqual(parseDelivery(raw, new Headers(signed), secret, { now, requireV2: true }), want);
        assert.equal(parseDelivery(raw, signed, secret, { now: now + 301000 }), null, 'stale v2 with a valid v1: refused, never a v1 fallback');
        assert.equal(parseDelivery(raw, { ...signed, 'X-OpenVibe-Signature-V2': `t=${now / 1000},v2=${'0'.repeat(64)}` }, secret, { now }), null, 'bad v2 with a valid v1: refused');
        assert.equal(parseDelivery(raw, { ...signed, 'X-OpenVibe-Signature-V2': '' }, secret, { now }), null, 'an empty v2 header is present and bad');
        assert.equal(parseDelivery(raw, { ...v1only, 'x-openvibe-signature-v2': signed['X-OpenVibe-Signature-V2'] }, secret, { now: now + 200000, toleranceSec: 100 }), null, 'toleranceSec is passed through');
        // No v2 header: v1 only while requireV2 is off.
        assert.deepEqual(parseDelivery(raw, v1only, secret), want, 'v1-only still parses by default (backward compatible)');
        assert.equal(parseDelivery(raw, v1only, secret, { requireV2: true }), null, 'requireV2 refuses a v1-only (replayable) delivery');
        assert.equal(parseDelivery(raw, { 'x-openvibe-signature': 'sha256=bad' }, secret), null);
        // A v2 delivery with a bad v1 still parses: v1 is not consulted once v2 is there.
        assert.deepEqual(parseDelivery(raw, { ...signed, 'X-OpenVibe-Signature': 'sha256=bad' }, secret, { now }), want);
    }],

    ['onPage runs only after every item of its page was handled: a crash mid-page keeps the old cursor', async () => {
        const { platform, events } = setup();
        for (let i = 1; i <= 6; i++) platform.publishEvent({ event_type: i === 3 ? 'live.other.thing' : 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: String(i) } });
        const log = [];
        let saved = 0;
        const consume = async (failAt) => {
            for await (const { seq } of events.iterate({ topic: 'media.vod.*', afterSeq: saved, limit: 3, onPage: (p) => { log.push(`page ${p.next_after_seq}`); saved = p.next_after_seq; } })) {
                if (seq === failAt) throw new Error(`crash at ${seq}`);
                log.push(`item ${seq}`);
            }
        };
        await assert.rejects(consume(2), /crash at 2/);
        assert.deepEqual(log, ['item 1']);
        assert.equal(saved, 0, 'a crash inside the first page saves nothing');
        log.length = 0;
        await assert.rejects(consume(5), /crash at 5/);
        assert.deepEqual(log, ['item 1', 'item 2', 'item 4', 'page 4'], 'page 1 (seq 1-4; 3 did not match) was saved after its last item; page 2 never was');
        assert.equal(saved, 4);
        log.length = 0;
        await consume(null);
        assert.deepEqual(log, ['item 5', 'item 6', 'page 6'], 'resumed from the saved cursor: nothing skipped');
        let pages = 0;
        for await (const e of events.iterate({ topic: 'media.vod.*', limit: 2, onPage: () => { pages++; } })) { void e; break; }
        assert.equal(pages, 0, 'breaking out before the page is done: no onPage');
    }],

    ['mock Events retention: pull and realtime report the pruned range as a gap', async () => {
        const { platform, events } = setup();
        for (let i = 1; i <= 5; i++) platform.publishEvent({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: String(i) }, visibility: 'public' });
        assert.equal(platform.pruneEvents(3), 3);
        const page = await events.pull({ topic: 'media.vod.*', afterSeq: 1 });
        assert.deepEqual(page.gap, { from_seq: 2, to_seq: 3 });
        assert.deepEqual(page.events.map((e) => e.seq), [4, 5]);
        assert.equal((await events.pull({ topic: 'media.vod.*', afterSeq: 3 })).gap, undefined);
        const gaps = [];
        const seqs = [];
        for await (const e of events.iterate({ topic: 'media.vod.*', onGap: (g) => gaps.push(g) })) seqs.push(e.seq);
        assert.deepEqual(gaps, [{ from_seq: 1, to_seq: 3 }]);
        assert.deepEqual(seqs, [4, 5]);
        const rtGaps = [];
        const got = [];
        const sub = subscribe('media.vod.*', (ev, { seq }) => got.push(seq), { client: createClient({ fetch: platform.fetch }), fetch: platform.fetch, transport: 'fetch', lastEventId: 1, onGap: (g) => rtGaps.push(g) });
        await waitFor(() => got.length === 2);
        sub.close();
        assert.deepEqual(rtGaps, [{ reason: 'retention', from_seq: 2, to_seq: 3, latest_seq: 5 }]);
        platform.publishEvent({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: '6' } });
        assert.equal((await events.pull({ afterSeq: 5 })).events[0].seq, 6, 'seqs keep counting after a prune');
    }],

    ['deliverEvents: signed deliveries to a local endpoint, retried in order, dead after max attempts', async () => {
        const { platform, events } = setup();
        const Database = require('better-sqlite3');
        const inbox = createInbox(new Database(':memory:'));
        inbox.ensureSchema();
        let failNext = 1;
        let secret;
        const handled = [];
        const srv = await stubServer((req, res, body) => {
            const d = parseDelivery(body, req.headers, secret, { requireV2: true });
            if (!d) return send(res, 401, { error: 'bad signature' });
            if (failNext > 0) { failNext--; return send(res, 503, { error: 'busy' }); }
            const r = inbox.once('webhook', d.event.event_id, () => handled.push([d.seq, d.attempt, req.headers['x-openvibe-event-type']]));
            return send(res, 200, { duplicate: r.duplicate });
        });
        platform.publishEvent({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: '0' } });   // before the subscription: not delivered
        const sub = await events.subscribe({ topicPattern: 'media.vod.*', endpoint: `${srv.url}/hook`, retryPolicy: { max_attempts: 3 } });
        secret = sub.secret;
        for (let i = 1; i <= 3; i++) platform.publishEvent({ event_type: i === 2 ? 'live.x.y' : 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: String(i) } });

        const first = await platform.deliverEvents();
        assert.deepEqual([first.delivered, first.failed, first.dead], [0, 1, 0], 'the first attempt failed: the subscription waits');
        const second = await platform.deliverEvents();
        assert.deepEqual([second.delivered, second.failed], [2, 0]);
        assert.deepEqual(handled, [[2, 2, 'media.vod.ready'], [4, 1, 'media.vod.ready']], 'in seq order, attempt counted, non-matching skipped');
        const req = srv.requests.at(-1);
        assert.equal(req.headers['x-openvibe-subscription-id'], sub.id);
        assert.match(req.headers['x-openvibe-signature'], /^sha256=[0-9a-f]{64}$/);
        assert.match(req.headers['x-openvibe-timestamp'], /^\d{10}$/);
        assert.equal(req.headers['x-openvibe-signature-v2'].split(',')[0], `t=${req.headers['x-openvibe-timestamp']}`);
        assert.equal(verifyDeliveryV2(req.body, req.headers, secret), true, 'the mock sends v2 too');
        assert.match(req.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        assert.equal((await platform.deliverEvents()).attempts.length, 0, 'nothing new');

        failNext = 99;
        platform.publishEvent({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: '9' } });
        const outcomes = [];
        for (let i = 0; i < 3; i++) outcomes.push((await platform.deliverEvents()).attempts.map((a) => a.outcome).join());
        assert.deepEqual(outcomes, ['retry', 'retry', 'dead']);
        assert.equal(platform.stats.deliveries.filter((a) => a.outcome === 'dead').length, 1);

        failNext = 0;
        const worker = platform.startDeliveries({ intervalMs: 5 });
        platform.publishEvent({ event_type: 'media.vod.ready', source: 'media', actor, subject: { type: 'vod', id: '10' } });
        await waitFor(() => handled.length === 3);
        await worker.stop();
        await srv.close();
    }],
]);
