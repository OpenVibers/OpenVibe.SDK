'use strict';
/**
 * openvibe-sdk/events (server): transactional outbox and inbox on the service's own better-sqlite3
 * database (ADR-004). No dependency: the caller passes its database handle.
 *
 *   const events = createEventsClient(client, { source: 'live' });
 *   const outbox = createOutbox(db, { events });
 *   outbox.ensureSchema();
 *   db.transaction(() => {
 *       db.prepare('UPDATE streams SET is_live = 1 WHERE id = ?').run(id);
 *       outbox.enqueue({ event_type: 'live.stream.started', actor, subject, payload });
 *   })();                       // the event exists if and only if the change committed
 *   outbox.start();             // relay: publishes due rows, marks them sent, backs off on failure
 *
 *   const inbox = createInbox(db);
 *   inbox.ensureSchema();
 *   inbox.once('network', event.event_id, () => { ...synchronous db writes... });
 *
 * Delivery is at least once: a crash between publish and mark-sent republishes the same event_id,
 * which OpenVibe.Events answers as a duplicate. A 4xx other than 401/408/409/425/429 is permanent
 * (the row is marked rejected and never retried); anything else is retried with backoff.
 */

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETRYABLE_4XX = new Set([401, 408, 409, 425, 429]);

function isPermanent(err) {
    const s = err && err.status;
    return Number.isInteger(s) && s >= 400 && s < 500 && !RETRYABLE_4XX.has(s);
}

function createOutbox(db, {
    events, table = 'event_outbox', batchSize = 50, intervalMs = 1000,
    backoffMs = [1000, 5000, 30000, 120000, 600000], now = () => Date.now(), onError = null, allowOutsideTransaction = false,
} = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('a better-sqlite3 database is required');
    if (!events || typeof events.publish !== 'function' || typeof events.prepare !== 'function') {
        throw new TypeError('events must be an openvibe-sdk events client (createEventsClient)');
    }
    if (!TABLE_RE.test(table)) throw new TypeError('bad outbox table name');
    let stmts = null;
    let timer = null;
    let running = false;
    let flushing = null;

    function ensureSchema() {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id        TEXT NOT NULL UNIQUE,
            envelope        TEXT NOT NULL,
            traceparent     TEXT,
            created_at      INTEGER NOT NULL,
            attempts        INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            sent_at         INTEGER,
            seq             INTEGER,
            rejected_at     INTEGER,
            last_error      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_${table}_due ON ${table}(sent_at, rejected_at, next_attempt_at);`);
        stmts = null;
    }

    function q() {
        if (!stmts) {
            stmts = {
                insert: db.prepare(`INSERT INTO ${table} (event_id, envelope, traceparent, created_at, next_attempt_at) VALUES (?, ?, ?, ?, 0)`),
                due: db.prepare(`SELECT * FROM ${table} WHERE sent_at IS NULL AND rejected_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT ?`),
                sent: db.prepare(`UPDATE ${table} SET sent_at = ?, seq = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`),
                failed: db.prepare(`UPDATE ${table} SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`),
                rejected: db.prepare(`UPDATE ${table} SET rejected_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`),
                pending: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sent_at IS NULL AND rejected_at IS NULL`),
                rejectedCount: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE rejected_at IS NOT NULL`),
                prune: db.prepare(`DELETE FROM ${table} WHERE sent_at IS NOT NULL AND sent_at < ?`),
            };
        }
        return stmts;
    }

    /** INSIDE the caller's transaction. Returns the complete envelope (event_id, timestamp, ...). */
    function enqueue(envelope, { traceparent } = {}) {
        if (!allowOutsideTransaction && !db.inTransaction) {
            throw new Error('outbox.enqueue() must run inside the transaction that makes the change');
        }
        const m = traceparent && TRACEPARENT_RE.exec(traceparent);
        const env = events.prepare(envelope, { traceId: m ? m[1] : undefined, now: now() });
        q().insert.run(env.event_id, JSON.stringify(env), m ? traceparent : null, now());
        return env;
    }

    const backoff = (attempts) => backoffMs[Math.min(attempts, backoffMs.length - 1)];

    function markFailure(row, err) {
        const message = String((err && err.message) || err).slice(0, 500);
        if (isPermanent(err)) q().rejected.run(now(), message, row.id);
        else q().failed.run(now() + backoff(row.attempts), message, row.id);
        if (onError) { try { onError(err, row); } catch { /* reporting must not break the relay */ } }
    }

    async function publishRows(rows) {
        const stats = { sent: 0, failed: 0, rejected: 0 };
        const envelopes = rows.map((r) => JSON.parse(r.envelope));
        const traceparent = rows[0].traceparent || undefined;
        try {
            const out = rows.length === 1
                ? { results: [await events.publish(envelopes[0], { traceparent })] }
                : await events.publish(envelopes, { traceparent });
            const byId = new Map(((out && out.results) || []).map((r) => [r.event_id, r]));
            db.transaction(() => { for (const row of rows) q().sent.run(now(), byId.get(row.event_id)?.seq ?? null, row.id); })();
            stats.sent += rows.length;
        } catch (err) {
            if (rows.length > 1 && isPermanent(err)) {
                // One bad envelope rejects the whole batch: isolate it.
                for (const row of rows) {
                    const s = await publishRows([row]);
                    stats.sent += s.sent; stats.failed += s.failed; stats.rejected += s.rejected;
                }
            } else {
                for (const row of rows) markFailure(row, err);
                if (isPermanent(err)) stats.rejected += rows.length; else stats.failed += rows.length;
            }
        }
        return stats;
    }

    async function doFlush() {
        const total = { sent: 0, failed: 0, rejected: 0 };
        for (;;) {
            const rows = q().due.all(now(), batchSize);
            if (!rows.length) break;
            const s = await publishRows(rows);
            total.sent += s.sent; total.failed += s.failed; total.rejected += s.rejected;
            if (s.failed || rows.length < batchSize) break;
        }
        return total;
    }

    /** Publish due rows once. Concurrent callers share the flush in progress. */
    function flush() {
        if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
        return flushing;
    }

    function schedule(ms) {
        if (!running) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            timer = null;
            try { await flush(); } catch (err) { if (onError) { try { onError(err); } catch { /* ignore */ } } }
            schedule(intervalMs);
        }, ms);
        if (timer.unref) timer.unref();
    }

    return {
        ensureSchema,
        enqueue,
        flush,
        start() { if (!running) { running = true; schedule(0); } },
        stop() { running = false; clearTimeout(timer); timer = null; return flushing || Promise.resolve(); },
        /** Wake the relay now (e.g. right after the transaction commits). */
        kick() { schedule(0); },
        pending: () => q().pending.get().n,
        rejected: () => q().rejectedCount.get().n,
        /** Delete sent rows older than `olderThanMs` (default 7 days). */
        prune(olderThanMs = 7 * 24 * 60 * 60 * 1000) { return q().prune.run(now() - olderThanMs).changes; },
    };
}

function createInbox(db, { table = 'idempotency_receipts', now = () => Date.now() } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('a better-sqlite3 database is required');
    if (!TABLE_RE.test(table)) throw new TypeError('bad inbox table name');
    let claim = null;

    function ensureSchema() {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
            consumer     TEXT NOT NULL,
            event_id     TEXT NOT NULL,
            processed_at INTEGER NOT NULL,
            PRIMARY KEY (consumer, event_id)
        )`);
        claim = null;
    }

    /** Run fn exactly once per (consumer, eventId), in one SQLite transaction with the receipt. */
    function once(consumer, eventId, fn) {
        if (!consumer || !eventId) throw new TypeError('consumer and eventId are required');
        if (!claim) claim = db.prepare(`INSERT OR IGNORE INTO ${table} (consumer, event_id, processed_at) VALUES (?, ?, ?)`);
        return db.transaction(() => {
            if (claim.run(String(consumer), String(eventId), now()).changes === 0) return { duplicate: true };
            const result = fn();
            if (result && typeof result.then === 'function') {
                throw new TypeError('inbox.once(): fn must be synchronous (it runs inside a SQLite transaction)');
            }
            return { duplicate: false, result };
        })();
    }

    function seen(consumer, eventId) {
        return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE consumer = ? AND event_id = ?`).get(String(consumer), String(eventId)));
    }

    return { ensureSchema, once, seen };
}

module.exports = { createOutbox, createInbox, isPermanent };
