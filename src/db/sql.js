'use strict';
/**
 * Safe SQL fragments for openvibe-sdk/db (ADR-035): a tagged template turns every interpolated value into a
 * bind parameter ($1, $2, …), so user data never becomes SQL text. Fragments nest, so a query can be
 * assembled from parts and still compile to one parameterised statement.
 *
 *   sql`SELECT id, title FROM pages WHERE space_id = ${spaceId} AND id = ANY(${ids})`
 *   sql`UPDATE pages SET ${sql.set({ title, body })} WHERE id = ${id}`
 *   sql`INSERT INTO tags ${sql.insert(rows, ['page_id', 'tag'])} ON CONFLICT DO NOTHING`
 *   sql`SELECT ${sql.join(cols.map(sql.ident))} FROM ${sql.ident('pages')}`
 *
 * Only sql.raw() puts text into the statement unchecked; keep it for constants you wrote yourself.
 */

class Sql {
    constructor(parts, values) {
        this.parts = parts;     // strings, one more than values
        this.values = values;   // plain values or nested Sql fragments
    }
    /** { text, values } with $n placeholders numbered from `start`. */
    compile(start = 1) {
        const out = { text: '', values: [] };
        append(this, out, start);
        return out;
    }
    toString() { return this.compile().text; }
}

function append(frag, out, start) {
    for (let i = 0; i < frag.parts.length; i++) {
        out.text += frag.parts[i];
        if (i >= frag.values.length) continue;
        const v = frag.values[i];
        if (v instanceof Sql) append(v, out, start);
        else { out.values.push(v === undefined ? null : v); out.text += `$${start + out.values.length - 1}`; }
    }
}

function sql(strings, ...values) {
    if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError('sql is a tagged template: sql`SELECT …`');
    return new Sql([...strings], values);
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** "name" or "schema"."name"; refuses anything that is not a plain identifier. */
sql.ident = (name) => {
    const parts = String(name).split('.');
    if (!parts.every((p) => IDENT_RE.test(p))) throw new TypeError(`sql.ident: not an identifier: ${name}`);
    return new Sql([parts.map((p) => `"${p}"`).join('.')], []);
};
/** Trusted text, inserted as is. Never pass user input. */
sql.raw = (text) => new Sql([String(text)], []);
/** Fragments (or values) joined by a separator fragment (default ", "). */
sql.join = (items, sep = sql`, `) => {
    const list = Array.from(items);
    if (!list.length) return new Sql([''], []);
    const parts = ['']; const values = [];
    list.forEach((item, i) => {
        if (i > 0) { values.push(sep); parts.push(''); }
        values.push(item); parts.push('');
    });
    return new Sql(parts, values);
};
/** `col = $1, col2 = $2` from an object (undefined keys are skipped). */
sql.set = (obj) => {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    if (!keys.length) throw new TypeError('sql.set: nothing to set');
    return sql.join(keys.map((k) => sql`${sql.ident(k)} = ${obj[k]}`));
};
/** `(a, b) VALUES ($1, $2), ($3, $4)` for a batch of rows; columns default to the first row's keys. */
sql.insert = (rows, columns) => {
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) throw new TypeError('sql.insert: no rows');
    const cols = columns || Object.keys(list[0]);
    const tuples = list.map((r) => sql`(${sql.join(cols.map((c) => (r[c] === undefined ? null : r[c])))})`);
    return sql`(${sql.join(cols.map(sql.ident))}) VALUES ${sql.join(tuples)}`;
};
/** A value as a jsonb bind parameter (objects and arrays are otherwise sent as PostgreSQL arrays). */
sql.json = (value) => sql`${value == null ? null : JSON.stringify(value)}::jsonb`;

sql.Sql = Sql;
const isSql = (v) => v instanceof Sql;

module.exports = { sql, Sql, isSql };
