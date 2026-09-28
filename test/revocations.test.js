'use strict';
// openvibe-sdk/auth createRevocationStore: network.user.token_valid_after cutoffs (Contracts 0.39.0).
const assert = require('assert');
const Database = require('better-sqlite3');
const { createRevocationStore, createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER } = require('../src/auth');

const A = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const B = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4';
const ev = (subject, iso, over = {}) => ({ event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', event_type: TOKEN_VALID_AFTER, version: 1, source: 'network', payload: { subject: { type: 'user', id: subject }, valid_after: iso, reason: 'signed_out_everywhere' }, ...over });
const T = Date.parse('2026-09-24T20:00:00Z');

const db = new Database(':memory:');
const s = createRevocationStore(db);
assert.strictEqual(s.isRevoked({ subject_id: A, iat: T / 1000 - 10 }), false, 'nothing known');
assert.strictEqual(s.apply(ev(A, new Date(T).toISOString())), 'revoked');
assert.strictEqual(s.isRevoked({ subject_id: A, iat: T / 1000 - 1 }), true, 'issued before: refused');
assert.strictEqual(s.isRevoked({ subject_id: A, iat: T / 1000 }), false, 'issued in the cutoff second: accepted (Network rule)');
assert.strictEqual(s.isRevoked({ subject_id: B, iat: T / 1000 - 1 }), false, 'someone else');
assert.strictEqual(s.isRevoked({ subject_id: A }), false, 'no iat, nothing to compare');
assert.strictEqual(s.apply(ev(A, new Date(T - 60000).toISOString())), 'unchanged', 'never moves back');
assert.strictEqual(s.apply(ev(A, new Date(T).toISOString())), 'unchanged', 'a redelivery');
assert.strictEqual(s.apply(ev(A, new Date(T + 1).toISOString(), { source: 'live' })), 'ignored:source');
assert.strictEqual(s.apply(ev('gst_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', new Date(T).toISOString())), 'ignored:payload');
assert.strictEqual(s.apply({ ...ev(A, 'soon') }), 'ignored:payload');
assert.strictEqual(s.apply({ event_type: 'network.module.updated' }), 'ignored:type');
assert.strictEqual(s.cutoffFor(A), T);

// Survives a restart (a new store on the same database); memory-only works without one.
assert.strictEqual(createRevocationStore(db).cutoffFor(A), T);
const mem = createRevocationStore();
assert.strictEqual(mem.apply(ev(B, new Date(T).toISOString())), 'revoked');
assert.strictEqual(mem.isRevoked({ subject_id: B, iat: T / 1000 - 5 }), true);
assert.throws(() => createRevocationStore(db, { table: 'x; DROP TABLE y' }), /bad table name/);

// createPgRevocationStore: the same rules on PostgreSQL (PGlite), cutoffs read into memory by load().
(async () => {
    const { createDb } = require('../src/db');
    const pg = createDb({ pglite: true, service: 'sdk-test' });
    await pg.exec(revocationSchema('token_revocations'));
    const p = createPgRevocationStore(pg, { table: 'token_revocations', now: () => T });
    assert.strictEqual(await p.load(), 0);
    assert.strictEqual(await p.apply(ev(A, new Date(T).toISOString())), 'revoked');
    assert.strictEqual(p.isRevoked({ subject_id: A, iat: T / 1000 - 1 }), true);
    assert.strictEqual(p.isRevoked({ subject_id: A, iat: T / 1000 }), false);
    assert.strictEqual(await p.apply(ev(A, new Date(T - 60000).toISOString())), 'unchanged', 'never moves back');
    assert.strictEqual(await p.apply(ev(A, new Date(T + 1).toISOString(), { source: 'live' })), 'ignored:source');
    // Another process moved it further: record() refuses to go back and takes the stored value.
    await pg.prepare('UPDATE token_revocations SET valid_after_ms = ? WHERE subject_id = ?').run(T + 5000, A);
    assert.strictEqual(await p.record(A, T + 1000), false);
    assert.strictEqual(p.cutoffFor(A), T + 5000);
    // A restart reads what is stored.
    const again = createPgRevocationStore(pg, { table: 'token_revocations' });
    assert.strictEqual(again.cutoffFor(A), 0, 'nothing before load()');
    assert.strictEqual(await again.load(), 1);
    assert.strictEqual(again.cutoffFor(A), T + 5000);
    assert.throws(() => createPgRevocationStore(pg, { table: 'x; DROP TABLE y' }), /bad table name/);
    await pg.close();
    console.log('revocations: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
