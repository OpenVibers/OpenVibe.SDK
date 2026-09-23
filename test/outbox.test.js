'use strict';
/** Outbox/inbox: enqueue only inside a transaction, relay publishes once, retries, rejects, dedupes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createEventsClient, createOutbox, createInbox } = require('../src/events');
const { createMockPlatform } = require('../src/testing');

const actor = { type: 'service', id: 'live' };
const subject = { type: 'stream', id: '12', revision: 1 };

function setup() {
    const platform = createMockPlatform({
        clients: { live: { secret: 'live-secret', grants: [['events.event.publish', 'openvibe.events']] } },
    });
    const tokens = createServiceTokenClient({ clientId: 'live', clientSecret: 'live-secret', fetch: platform.fetch });
    const client = createClient({ fetch: platform.fetch, tokenProvider: tokens, retries: 0 });
    const events = createEventsClient(client, { source: 'live' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-outbox-'));
    const db = new Database(path.join(dir, 'svc.db'));
    db.exec('CREATE TABLE streams (id INTEGER PRIMARY KEY, is_live INTEGER)');
    return { platform, events, db };
}

run([
    ['enqueue refuses to run outside a transaction', async () => {
        const { events, db } = setup();
        const outbox = createOutbox(db, { events });
        outbox.ensureSchema();
        assert.throws(() => outbox.enqueue({ event_type: 'live.stream.started', actor, subject }), /inside the transaction/);
    }],
    ['a rolled-back change leaves no event; a committed one is published once', async () => {
        const { platform, events, db } = setup();
        const outbox = createOutbox(db, { events });
        outbox.ensureSchema();
        assert.throws(() => db.transaction(() => {
            db.prepare('INSERT INTO streams (id, is_live) VALUES (1, 1)').run();
            outbox.enqueue({ event_type: 'live.stream.started', actor, subject });
            throw new Error('boom');
        })());
        assert.equal(outbox.pending(), 0);
        let env;
        db.transaction(() => {
            db.prepare('INSERT INTO streams (id, is_live) VALUES (2, 1)').run();
            env = outbox.enqueue({ event_type: 'live.stream.started', actor, subject, payload: { stream_id: 2 } }, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
        })();
        assert.match(env.event_id, /^evt_/);
        assert.equal(env.trace_id, '0af7651916cd43dd8448eb211c80319c');
        assert.equal(outbox.pending(), 1);
        const s = await outbox.flush();
        assert.deepEqual(s, { sent: 1, failed: 0, rejected: 0 });
        assert.equal(outbox.pending(), 0);
        assert.equal(platform.state.events.length, 1);
        assert.equal(platform.state.events[0].event.event_id, env.event_id);
        await outbox.flush();
        assert.equal(platform.state.events.length, 1, 'nothing republished');
    }],
    ['a transient failure backs off and retries; a batch publishes together', async () => {
        const { platform, events, db } = setup();
        let t = 1_000_000;
        let fail = true;
        const flaky = { prepare: events.prepare, publish: (...a) => (fail ? Promise.reject(Object.assign(new Error('down'), { status: 503 })) : events.publish(...a)) };
        const outbox = createOutbox(db, { events: flaky, now: () => t });
        outbox.ensureSchema();
        db.transaction(() => { for (let i = 0; i < 3; i++) outbox.enqueue({ event_type: 'live.stream.started', actor, subject: { type: 'stream', id: String(i) } }); })();
        assert.deepEqual(await outbox.flush(), { sent: 0, failed: 3, rejected: 0 });
        fail = false;
        assert.deepEqual(await outbox.flush(), { sent: 0, failed: 0, rejected: 0 }, 'not due yet');
        t += 1000;
        assert.deepEqual(await outbox.flush(), { sent: 3, failed: 0, rejected: 0 });
        assert.equal(platform.state.events.length, 3);
    }],
    ['a permanent 4xx rejects only the bad row', async () => {
        const { platform, events, db } = setup();
        const picky = {
            prepare: events.prepare,
            publish: (input, o) => {
                const list = Array.isArray(input) ? input : [input];
                if (list.some((e) => e.subject.id === 'bad')) return Promise.reject(Object.assign(new Error('events.type_not_allowed'), { status: 403 }));
                return events.publish(input, o);
            },
        };
        const outbox = createOutbox(db, { events: picky });
        outbox.ensureSchema();
        db.transaction(() => {
            outbox.enqueue({ event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'ok1' } });
            outbox.enqueue({ event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'bad' } });
            outbox.enqueue({ event_type: 'live.stream.started', actor, subject: { type: 'stream', id: 'ok2' } });
        })();
        assert.deepEqual(await outbox.flush(), { sent: 2, failed: 0, rejected: 1 });
        assert.equal(outbox.pending(), 0);
        assert.equal(outbox.rejected(), 1);
        assert.equal(platform.state.events.length, 2);
    }],
    ['a token-endpoint refusal is retried, never rejected', async () => {
        const { events, db } = setup();
        const noGrant = { prepare: events.prepare, publish: () => Promise.reject(Object.assign(new Error('unauthorized_client'), { status: 400, url: 'http://127.0.0.1:4000/oauth/token' })) };
        const outbox = createOutbox(db, { events: noGrant });
        outbox.ensureSchema();
        db.transaction(() => outbox.enqueue({ event_type: 'live.stream.started', actor, subject }))();
        assert.deepEqual(await outbox.flush(), { sent: 0, failed: 1, rejected: 0 });
        assert.equal(outbox.rejected(), 0);
        assert.equal(outbox.pending(), 1);
    }],
    ['inbox runs a handler exactly once and rolls back with it', async () => {
        const { db } = setup();
        const inbox = createInbox(db);
        inbox.ensureSchema();
        assert.throws(() => inbox.once('network', 'evt_1', () => { db.prepare('INSERT INTO streams (id, is_live) VALUES (9, 1)').run(); throw new Error('crash'); }));
        assert.equal(inbox.seen('network', 'evt_1'), false);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM streams').get().n, 0);
        assert.deepEqual(inbox.once('network', 'evt_1', () => { db.prepare('INSERT INTO streams (id, is_live) VALUES (9, 1)').run(); return 'done'; }), { duplicate: false, result: 'done' });
        assert.deepEqual(inbox.once('network', 'evt_1', () => { throw new Error('must not run'); }), { duplicate: true });
        assert.throws(() => inbox.once('network', 'evt_2', async () => {}), /synchronous/);
    }],
]);
