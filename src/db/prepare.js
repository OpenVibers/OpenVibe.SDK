'use strict';
/**
 * db.prepare(text): async statements shaped like better-sqlite3's, so a service moving from SQLite changes its
 * call sites by adding `await` (the SQL itself still has to be PostgreSQL). Parameters are written as SQLite code
 * wrote them and compiled once to PostgreSQL's $n:
 *   ?            positional, in order
 *   @name :name  named, bound from one plain object; a name used twice is one parameter
 * Question marks, @ and : inside '…' strings, "…" identifiers, dollar-quoted bodies and comments are left alone,
 * and so are :: casts.
 *
 *   const q = db.prepare('SELECT * FROM pages WHERE space_id = @space AND slug = @slug');
 *   await q.get({ space, slug });            // row or undefined
 *   await q.all(...);                        // rows
 *   await q.run(...);                        // { changes, rows, lastInsertRowid } (lastInsertRowid needs RETURNING)
 *   await q.pluck().get(...);                // the first column's value
 */

function compile(text) {
    let out = '';
    const names = new Map();   // name -> $n
    let positional = 0;
    let n = 0;
    let i = 0;
    const len = text.length;
    while (i < len) {
        const c = text[i];
        const next = text[i + 1];
        if (c === "'" || c === '"') {
            const j = skipQuoted(text, i, c);
            out += text.slice(i, j); i = j; continue;
        }
        if (c === '-' && next === '-') { const j = text.indexOf('\n', i); const e = j < 0 ? len : j; out += text.slice(i, e); i = e; continue; }
        if (c === '/' && next === '*') { const j = text.indexOf('*/', i + 2); const e = j < 0 ? len : j + 2; out += text.slice(i, e); i = e; continue; }
        if (c === '$' && /[A-Za-z_$]/.test(next || '')) {
            const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
            if (m) { const end = text.indexOf(m[0], i + m[0].length); const e = end < 0 ? len : end + m[0].length; out += text.slice(i, e); i = e; continue; }
        }
        if (c === ':' && next === ':') { out += '::'; i += 2; continue; }
        if (c === '?') { n++; positional++; out += `$${n}`; i++; continue; }
        if ((c === '@' || c === ':') && /[A-Za-z_]/.test(next || '')) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
            const name = m[0];
            if (!names.has(name)) { n++; names.set(name, n); }
            out += `$${names.get(name)}`;
            i += 1 + name.length;
            continue;
        }
        out += c; i++;
    }
    if (positional && names.size) throw new TypeError('openvibe-sdk/db prepare: use either ? or named parameters in one statement, not both');
    return { text: out, names: names.size ? [...names.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k) : null, count: n };
}

function skipQuoted(text, i, q) {
    let j = i + 1;
    while (j < text.length) {
        if (text[j] === q) { if (text[j + 1] === q) { j += 2; continue; } return j + 1; }
        j++;
    }
    return j;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v) && !ArrayBuffer.isView(v);

function bind(stmt, args) {
    if (stmt.names) {
        const o = args[0];
        if (args.length !== 1 || !isPlainObject(o)) throw new TypeError('openvibe-sdk/db prepare: this statement takes one object of named parameters');
        return stmt.names.map((k) => {
            if (!(k in o)) throw new TypeError(`openvibe-sdk/db prepare: missing parameter @${k}`);
            return o[k] === undefined ? null : o[k];
        });
    }
    const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (flat.length !== stmt.count) throw new TypeError(`openvibe-sdk/db prepare: expected ${stmt.count} parameter(s), got ${flat.length}`);
    return flat.map((v) => (v === undefined ? null : v));
}

function prepare(h, text, { pluck = false } = {}) {
    if (typeof text !== 'string') throw new TypeError('openvibe-sdk/db prepare: pass the SQL text');
    const stmt = compile(text);
    const first = (row) => (row ? row[Object.keys(row)[0]] : undefined);
    const api = {
        source: stmt.text,
        async get(...args) { const r = await h.query(stmt.text, bind(stmt, args)); const row = r.rows[0]; return pluck ? first(row) : row; },
        async all(...args) { const r = await h.query(stmt.text, bind(stmt, args)); return pluck ? r.rows.map(first) : r.rows; },
        async run(...args) {
            const r = await h.query(stmt.text, bind(stmt, args));
            const row = r.rows && r.rows[0];
            return { changes: r.rowCount, rows: r.rows || [], lastInsertRowid: row ? first(row) : undefined };
        },
        pluck(on = true) { return prepare(h, text, { pluck: on }); },
    };
    return api;
}

module.exports = { prepare, compile };
