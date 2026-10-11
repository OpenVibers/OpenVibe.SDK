'use strict';
// openvibe-sdk/auth createPgRevocationStore: network.user.token_valid_after cutoffs (Contracts 0.39.0).
const assert = require('assert');
const { createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER } = require('../src/auth');

const A = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const B = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4';
const ev = (subject, iso, over = {}) => ({ event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', event_type: TOKEN_VALID_AFTER, version: 1, source: 'network', payload: { subject: { type: 'user', id: subject }, valid_after: iso, reason: 'signed_out_everywhere' }, ...over });
const T = Date.parse('2026-09-24T20:00:00Z');

// createPgRevocationStore on PostgreSQL (PGlite): cutoffs read into memory by load(), written through.
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
    assert.strictEqual(p.isRevoked({ subject_id: B, iat: T / 1000 - 1 }), false, 'someone else');
    assert.strictEqual(p.isRevoked({ subject_id: A }), false, 'no iat, nothing to compare');
    assert.strictEqual(await p.apply(ev(A, new Date(T).toISOString())), 'unchanged', 'a redelivery');
    assert.strictEqual(await p.apply(ev('gst_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', new Date(T).toISOString())), 'ignored:payload');
    assert.strictEqual(await p.apply({ ...ev(A, 'soon') }), 'ignored:payload');
    assert.strictEqual(await p.apply({ event_type: 'network.module.updated' }), 'ignored:type');
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
