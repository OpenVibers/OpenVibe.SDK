'use strict';
/**
 * A service's SQLite DDL (the SCHEMA string its db.js ran) → PostgreSQL DDL with the same meaning (ADR-035), for
 * migrations/0001_initial.sql:
 *   INTEGER PRIMARY KEY AUTOINCREMENT → bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY (the importer keeps the ids)
 *   TEXT     → text COLLATE "C"   (SQLite compares text bytewise; "C" sorts and compares the same way)
 *   INTEGER  → bigint             (epoch milliseconds and counters; openvibe-sdk/db returns int8 as Number)
 *   REAL     → double precision,  BLOB → bytea
 *   CREATE … IF NOT EXISTS → CREATE … (a migration runs once)
 * Types only in column position (upper case, as SQLite schemas are written); comments are kept. Triggers
 * (RAISE(ABORT, …)) are refused: write them as PL/pgSQL by hand.
 *
 *   const { toPg } = require('openvibe-sdk/tools/asyncify/sqlite-schema-to-pg');   (from a checkout)
 */
function toPg(sql) {
    if (/CREATE\s+TRIGGER/i.test(sql)) throw new Error('sqlite-schema-to-pg: triggers need writing as PL/pgSQL by hand');
    return sql
        .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/g, 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY')
        .replace(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g, (m, u) => `CREATE ${u || ''}INDEX`)
        .replace(/CREATE TABLE IF NOT EXISTS/g, 'CREATE TABLE')
        .replace(/CREATE VIEW IF NOT EXISTS/g, 'CREATE VIEW')
        .replace(/^(\s*\w+\s+)TEXT\b/gm, '$1text COLLATE "C"')
        .replace(/^(\s*\w+\s+)INTEGER\b/gm, '$1bigint')
        .replace(/^(\s*\w+\s+)REAL\b/gm, '$1double precision')
        .replace(/^(\s*\w+\s+)BLOB\b/gm, '$1bytea');
}

module.exports = { toPg };
