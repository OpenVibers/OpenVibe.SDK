'use strict';
/**
 * Per-person token cutoffs from OpenVibe.Network (Contracts 0.39.0 network.user.token_valid_after).
 *
 * When someone signs out everywhere, changes or resets their password, is banned or has their sessions
 * ended by staff, Network moves their cutoff and publishes it. A service that accepts Network user
 * tokens subscribes to the event, applies it here and asks isRevoked() after verifying a token:
 * Network's rule is `iat * 1000 < valid_after` → refuse.
 *
 *   const cutoffs = createRevocationStore(db)        // a better-sqlite3 handle; omit for memory only
 *   cutoffs.apply(envelope)   → 'revoked' | 'unchanged' | 'ignored:<why>'   (idempotent: keeps the later cutoff)
 *   cutoffs.isRevoked(claims) → true when claims.iat is before claims.subject_id's cutoff
 *   cutoffs.cutoffFor(subject) → ms (0 = none)
 *   cutoffs.record(subject, validAfterMs, reason?) → true when it moved forward
 *
 * apply() only acts on source network and a well-formed payload, so a forged or foreign envelope that
 * slipped past a signature check still changes nothing. Closing sockets and dropping caches is the
 * caller's: apply() returns 'revoked' when the cutoff moved.
 */

const EVENT_TYPE = 'network.user.token_valid_after';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function createRevocationStore(db = null, { table = 'ov_token_revocations', now = () => Date.now(), maxCache = 50000 } = {}) {
    if (!TABLE_RE.test(table)) throw new TypeError(`createRevocationStore: bad table name ${table}`);
    const cache = new Map();
    let q = null;
    function ready() {
        if (!db || q) return q;
        // floating-ok: better-sqlite3 db.exec is synchronous
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
            subject_id     TEXT PRIMARY KEY,
            valid_after_ms INTEGER NOT NULL,
            reason         TEXT,
            updated_at     INTEGER NOT NULL
        )`);
        q = {
            get: db.prepare(`SELECT valid_after_ms FROM ${table} WHERE subject_id = ?`),
            put: db.prepare(`INSERT INTO ${table} (subject_id, valid_after_ms, reason, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(subject_id) DO UPDATE SET valid_after_ms = excluded.valid_after_ms, reason = excluded.reason, updated_at = excluded.updated_at
                WHERE excluded.valid_after_ms > ${table}.valid_after_ms`),
        };
        return q;
    }

    function cutoffFor(subject) {
        if (!subject) return 0;
        if (cache.has(subject)) return cache.get(subject);
        const s = ready();
        const row = s ? s.get.get(subject) : null;
        const ms = row ? Number(row.valid_after_ms) || 0 : 0;
        if (cache.size >= maxCache) cache.clear();
        cache.set(subject, ms);
        return ms;
    }

    function record(subject, validAfterMs, reason = null) {
        if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(validAfterMs)) return false;
        if (!(validAfterMs > cutoffFor(subject))) return false;
        const s = ready();
        if (s) s.put.run(subject, validAfterMs, reason, now());
        cache.set(subject, validAfterMs);
        return true;
    }

    function apply(event) {
        if (!event || event.event_type !== EVENT_TYPE) return 'ignored:type';
        if (event.source !== 'network') return 'ignored:source';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const subject = p.subject && p.subject.type === 'user' ? p.subject.id : null;
        const ms = Date.parse(p.valid_after);
        if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(ms)) return 'ignored:payload';
        return record(subject, ms, typeof p.reason === 'string' ? p.reason.slice(0, 40) : null) ? 'revoked' : 'unchanged';
    }

    function isRevoked(claims) {
        if (!claims || typeof claims.iat !== 'number' || typeof claims.subject_id !== 'string') return false;
        return claims.iat * 1000 < cutoffFor(claims.subject_id);
    }

    return { apply, record, isRevoked, cutoffFor, EVENT_TYPE };
}

/** The PostgreSQL table createPgRevocationStore uses, for the service's migration. */
function revocationSchema(table = 'ov_token_revocations') {
    if (!TABLE_RE.test(table)) throw new TypeError(`revocationSchema: bad table name ${table}`);
    return `CREATE TABLE IF NOT EXISTS ${table} (
    subject_id     text COLLATE "C" PRIMARY KEY,
    valid_after_ms bigint NOT NULL,
    reason         text,
    updated_at     bigint NOT NULL
);`;
}

/**
 * The same cutoffs on PostgreSQL (an openvibe-sdk/db handle; ADR-035). isRevoked() and cutoffFor() stay synchronous
 * (they run on every authenticated request): `await load()` reads every cutoff into memory at boot (people with a
 * cutoff are few), and apply()/record() write through, awaited, before the memory moves. One process per service:
 * a cutoff another process records reaches this one on its next load().
 *
 *   const cutoffs = createPgRevocationStore(db, { table: 'token_revocations' });   // table in the migration: revocationSchema()
 *   await cutoffs.load();
 *   await cutoffs.apply(envelope)   → 'revoked' | 'unchanged' | 'ignored:<why>'
 *   cutoffs.isRevoked(claims)       → boolean (memory)
 */
function createPgRevocationStore(db, { table = 'ov_token_revocations', now = () => Date.now() } = {}) {
    if (!TABLE_RE.test(table)) throw new TypeError(`createPgRevocationStore: bad table name ${table}`);
    if (!db || typeof db.prepare !== 'function') throw new TypeError('createPgRevocationStore: an openvibe-sdk/db handle is required');
    const cutoffs = new Map();
    let loaded = false;
    async function load() {
        const rows = await db.prepare(`SELECT subject_id, valid_after_ms FROM ${table}`).all();
        cutoffs.clear();
        for (const r of rows) cutoffs.set(r.subject_id, Number(r.valid_after_ms) || 0);
        loaded = true;
        return cutoffs.size;
    }
    const cutoffFor = (subject) => (subject ? cutoffs.get(subject) || 0 : 0);
    async function record(subject, validAfterMs, reason = null) {
        if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(validAfterMs)) return false;
        if (!(validAfterMs > cutoffFor(subject))) return false;
        const row = await db.prepare(`INSERT INTO ${table} (subject_id, valid_after_ms, reason, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (subject_id) DO UPDATE SET valid_after_ms = excluded.valid_after_ms, reason = excluded.reason, updated_at = excluded.updated_at
            WHERE excluded.valid_after_ms > ${table}.valid_after_ms
            RETURNING valid_after_ms`).get(subject, validAfterMs, reason, now());
        // No row back: the stored cutoff was already later (another process); read it.
        const ms = row ? Number(row.valid_after_ms) : Number((await db.prepare(`SELECT valid_after_ms FROM ${table} WHERE subject_id = ?`).get(subject) || {}).valid_after_ms) || 0;
        if (ms > cutoffFor(subject)) cutoffs.set(subject, ms);
        return Boolean(row);
    }
    async function apply(event) {
        if (!event || event.event_type !== EVENT_TYPE) return 'ignored:type';
        if (event.source !== 'network') return 'ignored:source';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const subject = p.subject && p.subject.type === 'user' ? p.subject.id : null;
        const ms = Date.parse(p.valid_after);
        if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(ms)) return 'ignored:payload';
        return (await record(subject, ms, typeof p.reason === 'string' ? p.reason.slice(0, 40) : null)) ? 'revoked' : 'unchanged';
    }
    function isRevoked(claims) {
        if (!claims || typeof claims.iat !== 'number' || typeof claims.subject_id !== 'string') return false;
        return claims.iat * 1000 < cutoffFor(claims.subject_id);
    }
    return { load, apply, record, isRevoked, cutoffFor, loaded: () => loaded, EVENT_TYPE };
}

module.exports = { createRevocationStore, createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER: EVENT_TYPE };
