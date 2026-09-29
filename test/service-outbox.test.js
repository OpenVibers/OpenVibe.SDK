'use strict';
/** createServiceOutbox: the per-service outbox wrapper, against PGlite and the mock platform. */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createServiceOutbox } = require('../src/events');
const { outboxSchema } = require('../src/events');
const { createMockPlatform } = require('../src/testing');
const { createDb, sql } = require('../src/db');

const actor = { type: 'service', id: 'trade' };
const subject = { type: 'instrument', id: 'AAPL' };
const platform = () => createMockPlatform({ clients: { trade: { secret: 'trade-secret', grants: [['events.event.publish', 'openvibe.events']] } } });

async function open(table = 'event_outbox') {
    const db = createDb({ pglite: true });
    await db.query(`CREATE TABLE changes (id INTEGER PRIMARY KEY); ${outboxSchema(table)}`);
    return db;
}
const make = (db, p, over = {}) => createServiceOutbox({
    db, source: 'trade', eventsUrl: 'https://events.openvibe.network', networkInternalUrl: 'https://openvibe.network',
    clientId: 'trade', clientSecret: 'trade-secret', fetch: p.fetch, log: { warn() {}, log() {} }, ...over,
});

run([
    ['emit joins the change\'s transaction: a rollback leaves nothing, a commit publishes once', async () => {
        const db = await open(); const p = platform();
        try {
            const out = make(db, p);
            assert.equal(out.enabled, true);
            await assert.rejects(db.tx(async (t) => { await t.exec(sql`INSERT INTO changes (id) VALUES (1)`); await out.emitIn(t, { event_type: 'trade.observation.created', actor, subject }); throw new Error('boom'); }), /boom/);
            assert.equal((await out.status()).pending, 0);
            const env = await db.tx(async (t) => { await t.exec(sql`INSERT INTO changes (id) VALUES (2)`); return out.emitIn(t, { event_type: 'trade.observation.created', actor, subject }); });
            assert.ok(env.event_id);
            assert.deepEqual(await out.outbox.flush(), { sent: 1, failed: 0, rejected: 0 });
            assert.equal(p.state.events.length, 1);
            assert.equal(p.state.events[0].event.source, 'trade');
            const s = await out.status();
            assert.deepEqual([s.enabled, s.pending, s.rejected, s.last_error], [true, 0, 0, null]);
        } finally { await db.close(); }
    }],
    ['without the events URL or the client secret the relay is off and rows wait', async () => {
        const db = await open(); const p = platform();
        try {
            const out = make(db, p, { clientSecret: null });
            assert.equal(out.enabled, false);
            await db.tx((t) => out.emitIn(t, { event_type: 'trade.observation.created', actor, subject }));
            out.start(); await out.kick(); out.stop();
            const s = await out.status();
            assert.deepEqual([s.enabled, s.pending], [false, 1]);
            assert.equal(p.state.events.length, 0);
        } finally { await db.close(); }
    }],
    ['eventTypes refuses an undeclared type; validate refuses a malformed envelope', async () => {
        const db = await open(); const p = platform();
        try {
            const out = make(db, p, { eventTypes: ['trade.observation.created'] });
            await assert.rejects(db.tx((t) => out.emitIn(t, { event_type: 'trade.other', actor, subject })), /undeclared event type trade.other/);
            const strict = make(db, p, { validate: (env) => (env.subject && env.subject.id ? { valid: true } : { valid: false, errors: [{ path: '/subject/id', message: 'is required' }] }) });
            await assert.rejects(db.tx((t) => strict.emitIn(t, { event_type: 'trade.observation.created', actor, subject: { type: 'instrument' } })), /invalid envelope for trade.observation.created: \/subject\/id is required/);
            await db.tx((t) => strict.emitIn(t, { event_type: 'trade.observation.created', actor, subject }));
            assert.equal((await strict.status()).pending, 1);
        } finally { await db.close(); }
    }],
    ['moderationAction is <source>.moderation.action; owner_subject can be withheld', async () => {
        const db = await open(); const p = platform();
        try {
            const out = make(db, p);
            await db.tx(async () => out.moderationAction({ action: 'hide', target: { type: 'post', id: 9, owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, actorSubject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', reason: 'spam' }));
            const noOwner = make(db, p, { moderationOwnerSubject: false });
            await db.tx(async () => noOwner.moderationAction({ action: 'hide', target: { type: 'post', id: 10, owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' } }));
            await out.outbox.flush();
            const [a, b] = p.state.events.map((e) => e.event);
            assert.equal(a.event_type, 'trade.moderation.action');
            assert.deepEqual([a.payload.target.owner_subject, a.actor.type, a.subject.id], ['usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'user', 'post:9']);
            assert.deepEqual([b.payload.target.owner_subject, b.actor], [null, { type: 'service', id: 'trade' }]);
        } finally { await db.close(); }
    }],
    ['a service with its own table name; misuse is a TypeError', async () => {
        const db = await open('tips_event_outbox'); const p = platform();
        try {
            const out = make(db, p, { table: 'tips_event_outbox' });
            await db.tx((t) => out.emitIn(t, { event_type: 'trade.observation.created', actor, subject }));
            assert.equal(await db.value(sql`SELECT count(*)::int FROM tips_event_outbox`), 1);
        } finally { await db.close(); }
        assert.throws(() => createServiceOutbox({ source: 'x' }), TypeError);
        assert.throws(() => createServiceOutbox({ db: {}, source: 'Bad Name' }), TypeError);
    }],
]);
