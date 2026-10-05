'use strict';
/**
 * openvibe-sdk/usage createUsageReporter: the shared step-7 relay. Key derivation, the idempotency key as the
 * outbox key (a replay changes nothing), transient failures retried with backoff (never dropped), and only
 * Billing refusing the reading itself (any 4xx but 401/403/404/408/425/429) rejects the row, kept with its
 * error. PGlite is the database (createPgOutbox is what the reporter relays with); the Billing POST is a stub fetch.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createDb, sql } = require('../src/db');
const { usageSample, usageKey, validateUsageSample, createUsageReporter } = require('../src/usage');

const quiet = { warn() {}, log() {}, error() {} };

/** A Billing stub: records each POST and answers the queued statuses, 201 once they run out. An Error entry
 *  is thrown instead (a network failure). */
function billingStub(statuses = []) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const status = statuses.length ? statuses.shift() : 201;
        calls.push({ url, method: opts.method, auth: opts.headers.Authorization, reading: JSON.parse(opts.body) });
        if (status instanceof Error) throw status;
        return { ok: status >= 200 && status < 300, status };
    };
    return { calls, fetchImpl };
}

function tokensStub() {
    const audiences = [];
    const invalidations = [];
    return { audiences, invalidations, tokenClient: {
        getToken: async ({ audience } = {}) => { audiences.push(audience); return 'svc-token'; },
        invalidate: ({ audience } = {}) => { invalidations.push(audience); },
    } };
}

const reading = (n) => usageSample({ id: `run:job_A:${n}`, idempotency_key: `run:job_A:${n}`, service: 'run',
    operation: 'function.invoke', quantity: 1, unit: 's', at: '2026-10-02T10:00:00Z', source: 'openvibe-node.worker' });

async function open({ statuses = [], table } = {}) {
    const db = createDb({ pglite: true });
    const billing = billingStub(statuses);
    const tokens = tokensStub();
    const now = { t: 1_000_000 };
    const reporter = createUsageReporter({ db, service: 'run', source: 'openvibe-node.worker', table,
        billingUrl: 'http://billing.internal/', tokenClient: tokens.tokenClient, fetchImpl: billing.fetchImpl,
        now: () => now.t, log: quiet });
    await reporter.ensureSchema();
    return { db, reporter, billing, tokens, now, done: () => db.close() };
}

/** One reading, one relay pass, against a Billing stub that answers `status` (an Error throws): the row's fate. */
async function deliverOnce(status) {
    const db = createDb({ pglite: true });
    const billing = billingStub([status]);
    const tokens = tokensStub();
    const reporter = createUsageReporter({ db, service: 'run', source: 'openvibe-node.worker',
        billingUrl: 'http://billing.internal/', tokenClient: tokens.tokenClient, fetchImpl: billing.fetchImpl,
        now: () => 1_000_000, log: quiet });
    await reporter.ensureSchema();
    try {
        await db.tx((t) => reporter.record(t, reading(0)));
        const stats = await reporter.flush();
        return { stats, pending: await reporter.pending(), rejected: await reporter.rejected(),
            lastError: await db.value(sql`SELECT last_error FROM ${sql.raw('usage_outbox')} WHERE event_id = ${'run:job_A:0'}`),
            billing, tokens };
    } finally { await db.close(); }
}

run([
    ['createUsageReporter requires a db, a service and a source', async () => {
        assert.throws(() => createUsageReporter({}), /db handle/);
        assert.throws(() => createUsageReporter({ db: { query() {}, tx() {} }, source: 's' }), /service/);
        assert.throws(() => createUsageReporter({ db: { query() {}, tx() {} }, service: 'run' }), /source/);
        assert.throws(() => createUsageReporter({ db: { query() {}, tx() {} }, service: 'run', source: 's', table: 'bad-name' }), /table name/);
    }],

    ['key derivation: key() is usageKey(service, …) and sample() fills in service, source and id', async () => {
        const { reporter, done } = await open();
        try {
            assert.equal(reporter.key('job', 'job_A', 3), 'run:job:job_A:3');
            assert.equal(reporter.key(), 'run');
            const s = reporter.sample({ idempotency_key: reporter.key('job', 'job_A', 0), operation: 'function.invoke',
                quantity: 1, unit: 's', resource: 'job_A', at: '2026-10-02T10:00:00Z' });
            assert.equal(s.service, 'run');
            assert.equal(s.source, 'openvibe-node.worker');
            assert.equal(s.id, s.idempotency_key, 'id defaults to the key');
            assert.deepEqual(validateUsageSample(s), { ok: true, errors: [] });
            const explicit = reporter.sample({ id: 'use-1', idempotency_key: 'k', service: 'someone-else', source: 'someone-else',
                operation: 'function.invoke', quantity: 1, unit: 's' });
            assert.equal(explicit.service, 'run', 'the reporter service wins');
            assert.equal(explicit.source, 'openvibe-node.worker');
            assert.equal(explicit.id, 'use-1', 'an explicit id is kept');
        } finally { await done(); }
    }],

    ['record queues an idempotency-keyed row inside the caller’s transaction, and refuses a replay', async () => {
        const { reporter, done, db } = await open();
        try {
            await assert.rejects(reporter.record(null, reading(0)), /transaction handle/);
            await assert.rejects(reporter.record({}, reading(0)), /transaction handle/);
            assert.equal(await db.tx((t) => reporter.record(t, reading(0))), true);
            assert.equal(await db.tx((t) => reporter.record(t, reading(0))), false, 'the same key is refused');
            // A different reading reusing the key is refused too: the outbox keeps the first.
            assert.equal(await db.tx((t) => reporter.record(t, { ...reading(0), quantity: 99 })), false);
            assert.equal(await reporter.pending(), 1);
            const env = await db.value(sql`SELECT envelope FROM ${sql.raw('usage_outbox')} WHERE event_id = ${'run:job_A:0'}`);
            assert.equal(env.quantity, 1, 'the first reading is the one kept');
            assert.equal(env.idempotency_key, 'run:job_A:0');
            assert.equal(await db.value(sql`SELECT count(*) FROM ${sql.raw('usage_outbox')}`), 1);
        } finally { await done(); }
    }],

    ['record throws on a reading that does not match platform.usage-sample@1', async () => {
        const { reporter, done, db } = await open();
        try {
            await assert.rejects(db.tx((t) => reporter.record(t, { id: 'x', idempotency_key: 'x' })), /platform\.usage-sample@1/);
            await assert.rejects(db.tx((t) => reporter.record(t, { service: 'run', operation: 'o', quantity: 1, unit: 's' })), /idempotency_key/);
        } finally { await done(); }
    }],

    ['a transient Billing failure retries with backoff and is never dropped or rejected', async () => {
        const { reporter, billing, tokens, now, done, db } = await open({ statuses: [503, 503] });
        try {
            await db.tx((t) => reporter.record(t, reading(0)));
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 1, rejected: 0 });
            assert.equal(await reporter.pending(), 1);
            assert.equal(await reporter.rejected(), 0);
            assert.equal(await db.value(sql`SELECT last_error FROM ${sql.raw('usage_outbox')} WHERE event_id = ${'run:job_A:0'}`), 'billing.usage.record answered 503');
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 0, rejected: 0 }, 'not due yet');
            now.t += 1000;
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 1, rejected: 0 });
            now.t += 5000;
            assert.deepEqual(await reporter.flush(), { sent: 1, failed: 0, rejected: 0 });
            assert.equal(await reporter.pending(), 0);
            assert.equal(billing.calls.length, 3);
            assert.equal(billing.calls[0].url, 'http://billing.internal/api/v1/usage');
            assert.equal(billing.calls[0].method, 'POST');
            assert.equal(billing.calls[0].auth, 'Bearer svc-token');
            assert.deepEqual(tokens.audiences, ['openvibe.billing', 'openvibe.billing', 'openvibe.billing']);
            assert.equal(billing.calls[0].reading.idempotency_key, 'run:job_A:0');
        } finally { await done(); }
    }],

    ['only Billing refusing the reading itself rejects the row, which is kept with its error', async () => {
        const { reporter, done, db } = await open({ statuses: [422] });
        try {
            await db.tx((t) => reporter.record(t, reading(0)));
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 0, rejected: 1 });
            assert.equal(await reporter.pending(), 0);
            assert.equal(await reporter.rejected(), 1);
            assert.equal(await db.value(sql`SELECT last_error FROM ${sql.raw('usage_outbox')} WHERE event_id = ${'run:job_A:0'}`), 'billing.usage.record answered 422');
            assert.ok(await db.value(sql`SELECT rejected_at FROM ${sql.raw('usage_outbox')} WHERE event_id = ${'run:job_A:0'}`), 'the refused row is kept, never deleted');
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 0, rejected: 0 }, 'a rejected row is never sent again');
        } finally { await done(); }
    }],

    ['without a billingUrl or tokenClient the reporter still queues, but the relay is off', async () => {
        const db = createDb({ pglite: true });
        try {
            const reporter = createUsageReporter({ db, service: 'run', source: 'openvibe-node.worker', log: quiet });
            assert.equal(reporter.enabled, false);
            await reporter.ensureSchema();
            await assert.rejects(reporter.record(null, reading(0)), /transaction handle/);
            await db.tx((t) => reporter.record(t, reading(0)));
            assert.equal(await reporter.pending(), 1, 'readings wait for a process with Billing configured');
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 0, rejected: 0 });
            assert.equal(typeof usageKey('run', 'job_A', 0), 'string');
        } finally { await db.close(); }
    }],

    ['the full Billing status matrix: only the reading itself is refused', async () => {
        // Credentials, grant, address or load: the reading is fine, so it stays pending and is retried.
        for (const status of [401, 403, 404, 408, 425, 429, 500]) {
            const r = await deliverOnce(status);
            assert.deepEqual(r.stats, { sent: 0, failed: 1, rejected: 0 }, `${status} stays pending`);
            assert.equal(r.pending, 1, `${status} is never dropped`);
            assert.equal(r.rejected, 0, `${status} is not the reading being refused`);
            assert.equal(r.lastError, `billing.usage.record answered ${status}`, `${status} keeps the real status in its error`);
        }
        // Billing refusing the reading itself: rejected, kept with its error, never sent again.
        for (const status of [400, 402, 409, 410, 413, 415, 422]) {
            const r = await deliverOnce(status);
            assert.deepEqual(r.stats, { sent: 0, failed: 0, rejected: 1 }, `${status} is refused`);
            assert.equal(r.pending, 0, `${status} leaves the queue`);
            assert.equal(r.rejected, 1);
            assert.equal(r.lastError, `billing.usage.record answered ${status}`);
        }
    }],

    ['a network error from Billing (fetch throws) stays pending with backoff', async () => {
        const r = await deliverOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));
        assert.deepEqual(r.stats, { sent: 0, failed: 1, rejected: 0 });
        assert.equal(r.pending, 1, 'a network error is never the reading being refused');
        assert.equal(r.rejected, 0);
    }],

    ['a 401 from Billing invalidates the cached service token before the retry', async () => {
        const { reporter, billing, tokens, now, db, done } = await open({ statuses: [401, 201] });
        try {
            await db.tx((t) => reporter.record(t, reading(0)));
            assert.deepEqual(await reporter.flush(), { sent: 0, failed: 1, rejected: 0 });
            assert.equal(await reporter.pending(), 1, 'a 401 is not the reading being refused');
            assert.deepEqual(tokens.invalidations, ['openvibe.billing'], 'the refused token is dropped');
            now.t += 1000;
            assert.deepEqual(await reporter.flush(), { sent: 1, failed: 0, rejected: 0 });
            assert.deepEqual(tokens.audiences, ['openvibe.billing', 'openvibe.billing'], 'the retry mints a fresh token');
            assert.deepEqual(tokens.invalidations, ['openvibe.billing'], 'only the 401 dropped the token');
            assert.equal(billing.calls.length, 2);
        } finally { await done(); }
    }],

    ['requireProject refuses a reading without a production project, and accepts one with it', async () => {
        const db = createDb({ pglite: true });
        try {
            const reporter = createUsageReporter({ db, service: 'run', source: 'openvibe-node.worker', requireProject: true, log: quiet });
            await reporter.ensureSchema();
            await assert.rejects(db.tx((t) => reporter.record(t, reading(0))), /production project/, 'a first-party reading (no project) is refused');
            // A malformed project fails contracts validation first; either way the reading is refused.
            await assert.rejects(db.tx((t) => reporter.record(t, { ...reading(0), project: 'sandbox' })), /production project|platform\.usage-sample@1/, 'a non-project project is refused');
            assert.equal(await db.tx((t) => reporter.record(t, { ...reading(0), project: 'prj_00000000000000000000000000' })), true);
            assert.equal(await reporter.pending(), 1);
        } finally { await db.close(); }
    }],

    ['start() schedules an unref’d relay timer and stop() clears it', async () => {
        const { reporter, done } = await open();
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        const scheduled = [];
        const cleared = [];
        globalThis.setTimeout = (fn, ms) => { const t = realSetTimeout(fn, ms); scheduled.push(t); return t; };
        globalThis.clearTimeout = (t) => { cleared.push(t); return realClearTimeout(t); };
        try {
            reporter.start();
            assert.equal(scheduled.length, 1, 'start schedules one timer');
            assert.equal(typeof scheduled[0].unref, 'function');
            assert.equal(scheduled[0].hasRef(), false, 'the relay timer is unref’d (it never keeps the process alive)');
            await reporter.stop();
            assert.ok(cleared.includes(scheduled[0]), 'stop clears the relay timer');
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
            await done();
        }
    }],
]);
