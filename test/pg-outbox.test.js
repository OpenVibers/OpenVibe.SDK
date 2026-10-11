'use strict';
/**
 * The PostgreSQL outbox and inbox (ADR-004 on ADR-035): enqueue needs the transaction handle, so a rolled-back
 * change leaves no event; the relay publishes once, backs off on a transient failure, rejects only a permanently
 * refused row, and several relays on one table never send an event twice (FOR UPDATE SKIP LOCKED with a lease);
 * the inbox runs a handler once per event in the handler's transaction. PGlite always; PostgreSQL through
 * PgBouncer when OV_TEST_PG_URL is set.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createEventsClient, createPgOutbox, createPgInbox, outboxSchema, inboxSchema } = require('../src/events');
const { createMockPlatform } = require('../src/testing');
const { createDb, sql } = require('../src/db');

const actor = { type: 'service', id: 'live' };
const subject = { type: 'stream', id: '12', revision: 1 };

function eventsClient() {
    const platform = createMockPlatform({ clients: { live: { secret: 'live-secret', grants: [['events.event.publish', 'openvibe.events']] } } });
    const tokens = createServiceTokenClient({ clientId: 'live', clientSecret: 'live-secret', fetch: platform.fetch });
    const client = createClient({ fetch: platform.fetch, tokenProvider: tokens, retries: 0 });
    return { platform, events: createEventsClient(client, { source: 'live' }) };
}

function cases(label, open) {
    return [
        [`${label}: enqueue needs the transaction; a rollback leaves no event; a commit publishes once`, async () => {
            const { db, done } = await open();
            try {
                const { platform, events } = eventsClient();
                const outbox = createPgOutbox(db, { events });
                await assert.rejects(outbox.enqueue(null, { event_type: 'live.stream.started', actor, subject }), /transaction handle/);
                await assert.rejects(db.tx(async (t) => {
                    await t.exec(sql`INSERT INTO streams (id, is_live) VALUES (1, true)`);
                    await outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject });
                    throw new Error('boom');
                }), /boom/);
                assert.equal(await outbox.pending(), 0);
                const env = await db.tx(async (t) => {
                    await t.exec(sql`INSERT INTO streams (id, is_live) VALUES (2, true)`);
                    return outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject, payload: { stream_id: 2 } }, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
                });
                assert.equal(env.trace_id, '0af7651916cd43dd8448eb211c80319c');
                assert.deepEqual(await outbox.flush(), { sent: 1, failed: 0, rejected: 0 });
                assert.equal(await outbox.pending(), 0);
                assert.equal(platform.state.events.length, 1);
                assert.equal(platform.state.events[0].event.event_id, env.event_id);
                await outbox.flush();
                assert.equal(platform.state.events.length, 1, 'nothing republished');
                assert.strictEqual(await db.value(sql`SELECT seq FROM event_outbox WHERE event_id = ${env.event_id}`), null, 'Events hands out no sequence number (ADR-042): nothing is recorded');
                // Published in the order written (UPDATE … RETURNING alone has no order).
                const written = [];
                for (let i = 0; i < 12; i++) {
                    written.push((await db.tx(async (t) => outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject, payload: { stream_id: 100 + i } }))).event_id);
                }
                await db.exec(sql`UPDATE event_outbox SET attempts = attempts WHERE event_id = ${written[3]}`);   // a later row version for one of them
                await outbox.flush();
                assert.deepEqual(platform.state.events.slice(1).map((e) => e.event.event_id), written);
            } finally { await done(); }
        }],
        [`${label}: transient failures back off; a permanent refusal rejects only its row`, async () => {
            const { db, done } = await open();
            try {
                const { platform, events } = eventsClient();
                let t = 1_000_000; let fail = true;
                const flaky = { prepare: events.prepare, publish: (...a) => (fail ? Promise.reject(Object.assign(new Error('down'), { status: 503 })) : events.publish(...a)) };
                const outbox = createPgOutbox(db, { events: flaky, now: () => t });
                await db.tx(async (tx) => { for (let i = 0; i < 3; i++) await outbox.enqueue(tx, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: String(i) } }); });
                assert.deepEqual(await outbox.flush(), { sent: 0, failed: 3, rejected: 0 });
                fail = false;
                assert.deepEqual(await outbox.flush(), { sent: 0, failed: 0, rejected: 0 }, 'not due yet');
                t += 1000;
                assert.deepEqual(await outbox.flush(), { sent: 3, failed: 0, rejected: 0 });
                assert.equal(platform.state.events.length, 3);
                const picky = { prepare: events.prepare, publish: (env) => (Array.isArray(env) || env.subject.id === 'bad' ? Promise.reject(Object.assign(new Error('invalid'), { status: 422 })) : events.publish(env)) };
                const o2 = createPgOutbox(db, { events: picky, now: () => t });
                await db.tx(async (tx) => { await o2.enqueue(tx, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'bad' } }); await o2.enqueue(tx, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'ok' } }); });
                assert.deepEqual(await o2.flush(), { sent: 1, failed: 0, rejected: 1 });
                assert.equal(await o2.rejected(), 1);
            } finally { await done(); }
        }],
        [`${label}: a token-endpoint refusal is retried, never rejected`, async () => {
            const { db, done } = await open();
            try {
                const { events } = eventsClient();
                const noGrant = { prepare: events.prepare, publish: () => Promise.reject(Object.assign(new Error('unauthorized_client'), { status: 400, url: 'http://127.0.0.1:4000/oauth/token' })) };
                const outbox = createPgOutbox(db, { events: noGrant });
                await db.tx(async (t) => { await outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'tok' } }); });
                assert.deepEqual(await outbox.flush(), { sent: 0, failed: 1, rejected: 0 }, 'no grant yet says nothing about the event');
                assert.equal(await outbox.rejected(), 0);
                assert.equal(await outbox.pending(), 1);
            } finally { await done(); }
        }],
        [`${label}: a flush during a pass also publishes what was committed after that pass claimed`, async () => {
            const { db, done } = await open();
            try {
                const { events } = eventsClient();
                let release; const gate = new Promise((r) => { release = r; });
                const sent = [];
                const slow = { prepare: events.prepare, publish: async (input, o) => { await gate; for (const e of [].concat(input)) sent.push(e.subject.id); return await events.publish(input, o); } };
                const outbox = createPgOutbox(db, { events: slow });
                await db.tx(async (t) => { await outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: '12' } }); });
                const first = outbox.flush();
                await new Promise((r) => setTimeout(r, 20));
                await db.tx(async (t) => { await outbox.enqueue(t, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: '13' } }); });
                const second = outbox.flush();
                assert.equal(outbox.flush(), second, 'calls during a pass share the next one');
                release();
                await first; await second;
                assert.deepEqual(sent.sort(), ['12', '13']);
                assert.equal(await outbox.pending(), 0);
            } finally { await done(); }
        }],
        [`${label}: the inbox runs a handler once, inside its transaction`, async () => {
            const { db, done } = await open();
            try {
                const inbox = createPgInbox(db);
                let runs = 0;
                const a = await inbox.once('network', 'evt_1', async (t) => { runs++; await t.exec(sql`INSERT INTO streams (id, is_live) VALUES (7, false)`); return 'ok'; });
                const b = await inbox.once('network', 'evt_1', async () => { runs++; });
                assert.deepEqual([a, b, runs], [{ duplicate: false, result: 'ok' }, { duplicate: true }, 1]);
                await assert.rejects(inbox.once('network', 'evt_2', async () => { throw new Error('fail'); }), /fail/);
                assert.equal(await inbox.seen('network', 'evt_2'), false, 'a failed handler leaves no receipt: it runs again next time');
            } finally { await done(); }
        }],
    ];
}

const schema = `CREATE TABLE streams (id bigint PRIMARY KEY, is_live boolean NOT NULL);\n${outboxSchema()}\n${inboxSchema()}`;
const tests = cases('pglite', async () => {
    const db = createDb({ pglite: true });
    await db.query(schema);
    return { db, done: () => db.close() };
});

if (process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL) {
    const pgOpen = async () => {
        const owner = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL });
        await owner.query('DROP TABLE IF EXISTS streams, event_outbox, idempotency_receipts CASCADE');
        await owner.query(schema);
        await owner.close();
        const db = createDb({ url: process.env.OV_TEST_PG_URL, max: 6 });
        return { db, done: () => db.close() };
    };
    tests.push(...cases('postgresql+pgbouncer', pgOpen));
    tests.push(['postgresql+pgbouncer: three relays on one table send each event exactly once', async () => {
        const { db, done } = await pgOpen();
        try {
            const { platform, events } = eventsClient();
            const slow = { prepare: events.prepare, publish: async (...a) => { await new Promise((r) => setTimeout(r, 30)); return events.publish(...a); } };
            const relays = [0, 1, 2].map(() => createPgOutbox(db, { events: slow, batchSize: 7 }));
            await db.tx(async (t) => { for (let i = 0; i < 60; i++) await relays[0].enqueue(t, { event_type: 'live.stream.started', actor, subject: { type: 'stream', id: String(i) } }); });
            const results = await Promise.all(relays.map(async (r) => { let sent = 0; for (;;) { const s = await r.flush(); sent += s.sent; if (!s.sent) break; } return sent; }));
            assert.equal(results.reduce((a, b) => a + b, 0), 60);
            assert.equal(platform.state.events.length, 60, 'no event sent twice');
            assert.ok(results.filter((n) => n > 0).length >= 2, `the work was shared: ${results}`);
        } finally { await done(); }
    }]);
} else console.log('pg outbox through PgBouncer: skipped (OV_TEST_PG_URL not set; scripts/test-services.sh up)');

run(tests);
