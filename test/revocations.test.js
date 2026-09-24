'use strict';
// openvibe-sdk/auth createRevocationStore: network.user.token_valid_after cutoffs (Contracts 0.39.0).
const assert = require('assert');
const Database = require('better-sqlite3');
const { createRevocationStore, TOKEN_VALID_AFTER } = require('../src/auth');

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
console.log('revocations: all checks passed');
