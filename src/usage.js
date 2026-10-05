'use strict';
/**
 * openvibe-sdk/usage — platform.usage-sample@1, one metered usage reading with retry-safe attribution
 * (T1 Universal Fabric). Construction and validation are pure and dependency-free: `openvibe-contracts`
 * is required lazily by validateUsageSample, the way src/service re-exports its packages. The reporter
 * below (server only, browser: null) does no I/O of its own either — it uses the db handle the caller
 * passes and relays with src/outbox's createPgOutbox.
 *
 *   const { usageSample, usageKey, validateUsageSample } = require('openvibe-sdk/usage');
 *   const record = usageSample({ id, idempotency_key: usageKey('media', 'delivery', 1), service: 'media',
 *       operation: 'deliver', quantity: 1.5, unit: 'GiB' });      // at and source default
 *   validateUsageSample(record);                                    // { ok, errors }
 *
 * createUsageReporter() is the shared step-7 recipe Tools, AI, Events and Bot each rewrote: one service's
 * readings, built and validated, queued idempotency-keyed in an outbox table inside the caller's
 * transaction, and relayed to Billing's billing.usage.record (POST /api/v1/usage, one reading per
 * request) with createPgOutbox, so a reading is never dropped: a relay that cannot reach Billing (down,
 * no grant yet, 401/403/404/429/5xx) retries with backoff across restarts, and only Billing refusing
 * the reading itself (400, 409, 413, 422) marks a row rejected — kept with its error and never sent
 * again, so nothing is billed twice. With no billingUrl or tokenClient the reporter still queues
 * readings; only the relay is off (they wait for a process that has both).
 *
 *   const reporter = createUsageReporter({ db, service: 'run', source: 'openvibe-node.worker',
 *       billingUrl, tokenClient: createServiceTokenClient({ clientId: 'run', clientSecret }) });
 *   await reporter.ensureSchema();                                  // services put it in a migration instead
 *   const reading = reporter.sample({ idempotency_key: reporter.key('job', jobId, n), operation: 'function.invoke',
 *       quantity: 1, unit: 's', resource: jobId, node: nodeId });
 *   await db.tx(async (t) => { await reporter.record(t, reading); });   // idempotent: a replay changes nothing
 *   reporter.start();
 *
 * No money fields are invented: cost_estimate, free_allowance_used and vibes_charged ride along only when
 * the caller passes them (rating is Billing's). openvibe-sdk/govern builds its onUsage record with usageSample().
 */

/** The fields platform.usage-sample@1 requires or allows, in the schema's order; null/undefined are stripped. */
function usageSample(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        idempotency_key: f.idempotency_key,
        service: f.service,
        project: f.project,
        subject: f.subject,
        resource: f.resource,
        provider: f.provider,
        node: f.node,
        cell: f.cell,
        region: f.region,
        operation: f.operation,
        quantity: f.quantity,
        unit: f.unit,
        at: f.at == null ? new Date().toISOString() : f.at,
        cost_estimate: f.cost_estimate,
        free_allowance_used: f.free_allowance_used,
        vibes_charged: f.vibes_charged,
        route_epoch: f.route_epoch,
        trace_id: f.trace_id,
        source: f.source == null ? 'openvibe-sdk/usage' : f.source,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** The stable idempotency key of a reading: the service, then each part, joined with ':'. */
function usageKey(service, ...parts) {
    if (typeof service !== 'string' || !service) throw new TypeError('usageKey: service must be a non-empty string');
    const rest = parts.filter((p) => p != null).map(String);
    return rest.length ? [service, ...rest].join(':') : service;
}

/** { ok, errors } for a record against platform.usage-sample@1. A missing openvibe-contracts is never a
 *  claim of validity: ok is false and errors stay empty (nothing was checked). */
function validateUsageSample(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed: nothing to check against */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.usage-sample@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

// ── the shared usage reporter (server-only): queue and relay one service's readings ───────────────

const { createPgOutbox, outboxSchema } = require('./outbox');

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATUSES = 'sent_at IS NULL AND rejected_at IS NULL';
// Billing refusing the reading itself (a malformed sample, or a key it already holds with a different
// body) is permanent; a token it has not granted, a missing route, a timeout or a 5xx is not.
const REFUSED = new Set([400, 409, 413, 422]);

/**
 * The reporter for one service's readings. It never invents a reading: `sample()` fills in the
 * reporter's service and source, and `record()` writes an already-built one. `record()` must run inside
 * the caller's transaction (`db.tx`'s handle), so a reading exists if and only if the change that
 * produced it committed; a repeated idempotency_key changes nothing (the outbox keeps the first).
 *
 * @param {object} o
 * @param {object} o.db           openvibe-sdk/db handle (server); the outbox table lives in the same database
 * @param {string} o.service      the Contracts service id (services/<id>.json), e.g. 'run', 'tools', 'ai'
 * @param {string} o.source       the sample's `source`, e.g. 'openvibe-node.worker', 'ai.runs'
 * @param {string} [o.table]      the outbox table (default 'usage_outbox'); services create it in a migration
 * @param {string} [o.billingUrl] OpenVibe.Billing's base URL; without it (or a tokenClient) only queueing happens
 * @param {{ getToken(ctx?: { audience?: string }): Promise<string> }} [o.tokenClient] openvibe-sdk/auth's
 *                                createServiceTokenClient (or anything with getToken)
 * @param {string} [o.audience]   the token audience (default 'openvibe.billing')
 * @param {Function} [o.fetchImpl] fetch for the Billing POST (default globalThis.fetch)
 * @param {number} [o.timeoutMs]  the Billing POST timeout (default 5000)
 * @param {number} [o.intervalMs] the relay tick (default 2000)
 * @param {number} [o.batchSize]  readings per publish (default 1: one reading per request)
 * @param {() => number} [o.now]  the clock the relay uses for backoff (tests pass one)
 * @param {object} [o.log]        warns once per distinct delivery error
 * @returns {object} `{ enabled, service, source, table, key, sample, record, ensureSchema, start, stop, kick, flush, prune, pending, rejected }`
 */
function createUsageReporter({
    db, service, source, table = 'usage_outbox', billingUrl, tokenClient, audience = 'openvibe.billing',
    fetchImpl = globalThis.fetch, timeoutMs = 5000, intervalMs = 2000, batchSize = 1, now = () => Date.now(), log = console,
} = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.tx !== 'function') throw new TypeError('createUsageReporter: an openvibe-sdk/db handle is required');
    if (typeof service !== 'string' || !service) throw new TypeError('createUsageReporter: service must be a non-empty string');
    if (typeof source !== 'string' || !source) throw new TypeError('createUsageReporter: source must be a non-empty string');
    if (!TABLE_RE.test(table)) throw new TypeError('createUsageReporter: bad outbox table name');
    if (fetchImpl != null && typeof fetchImpl !== 'function') throw new TypeError('createUsageReporter: fetchImpl must be a function');
    const canRelay = Boolean(billingUrl && tokenClient && typeof tokenClient.getToken === 'function');

    /** The service's stable idempotency key, e.g. key('job', id, n) -> `run:job:<id>:<n>`. */
    function key(...parts) { return usageKey(service, ...parts); }

    /** A reading for this service and source; `service` and `source` are the reporter's, `id` defaults to the key. */
    function sample(fields) {
        const f = fields || {};
        return usageSample({ ...f, service, source, id: f.id == null ? f.idempotency_key : f.id });
    }

    /**
     * INSIDE the caller's transaction: validate and queue the reading under its idempotency_key.
     * -> true when this call inserted it, false when the key was already queued. An invalid reading
     * throws (when openvibe-contracts is installed); a missing contracts never blocks the queue.
     */
    async function record(t, reading) {
        if (!t || typeof t.query !== 'function' || typeof t.tx !== 'function') throw new TypeError('usageReporter.record(t, reading): pass the transaction handle db.tx gives you');
        if (!reading || typeof reading !== 'object') throw new TypeError('usageReporter.record: a platform.usage-sample@1 reading is required');
        const v = validateUsageSample(reading);
        if (!v.ok && v.errors.length) throw new Error(`usage reading ${reading.idempotency_key || reading.id || '(no key)'} is not a valid platform.usage-sample@1: ${JSON.stringify(v.errors)}`);
        if (typeof reading.idempotency_key !== 'string' || !reading.idempotency_key) throw new TypeError('usageReporter.record: reading.idempotency_key is required (it is the outbox key)');
        const n = await t.exec(`INSERT INTO ${table} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
            [reading.idempotency_key, JSON.stringify(reading), now()]);
        return n > 0;
    }

    /** Create the outbox table where the handle may (tests, PGlite); services put outboxSchema(table) in a migration. */
    const ensureSchema = () => db.query(outboxSchema(table));

    // createPgOutbox's `events` seam pointed at Billing: one reading per POST. isPermanent() reads err.status.
    const billingSink = {
        prepare: (reading) => reading,
        async publish(reading) {
            const token = await tokenClient.getToken({ audience });
            const res = await fetchImpl(`${String(billingUrl).replace(/\/+$/, '')}/api/v1/usage`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(reading), signal: AbortSignal.timeout(timeoutMs),
            });
            // 201 written, 200 an identical reading replayed: either way Billing holds it.
            if (!res.ok) {
                const err = new Error(`billing.usage.record answered ${res.status}`);
                err.status = REFUSED.has(res.status) ? 422 : 503;   // 401/403 before the grant, 404 before Billing ships the route, 429, 5xx: retried
                throw err;
            }
            return { event_id: reading.idempotency_key || reading.id, seq: null };
        },
    };
    let lastError = null;
    const relay = canRelay ? createPgOutbox(db, {
        events: billingSink, table, batchSize, intervalMs, now,
        onError: (err) => { const m = err && err.message; if (m !== lastError) { lastError = m; if (log && log.warn) log.warn(`[usage] ${service} reading not delivered (will retry): ${m}`); } },
    }) : null;

    const count = (where) => db.value(`SELECT count(*) FROM ${table} WHERE ${where}`).then(Number);

    return {
        enabled: canRelay, service, source, table,
        key, sample, record, ensureSchema,
        start: () => { if (relay) relay.start(); },
        stop: () => (relay ? relay.stop() : Promise.resolve()),
        kick: () => { if (relay) relay.kick(); },
        flush: () => (relay ? relay.flush() : Promise.resolve({ sent: 0, failed: 0, rejected: 0 })),
        prune: (olderThanMs) => (relay ? relay.prune(olderThanMs) : Promise.resolve(0)),
        pending: () => count(STATUSES),
        rejected: () => count('rejected_at IS NOT NULL'),
    };
}

module.exports = { usageSample, usageKey, validateUsageSample, createUsageReporter };
