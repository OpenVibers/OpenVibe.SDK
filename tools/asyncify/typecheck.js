#!/usr/bin/env node
'use strict';
// Every column declared INTEGER/REAL holding a value of another storage class (SQLite's affinity lets text in).
const Database = require(require.resolve('better-sqlite3', { paths: [process.cwd()] }));
const db = new Database(process.argv[2], { readonly: true });
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
        const t = String(c.type).toUpperCase();
        const want = /INT/.test(t) ? 'integer' : /REAL|FLOA|DOUB/.test(t) ? 'real' : null;
        if (!want) continue;
        const rows = db.prepare(`SELECT typeof("${c.name}") AS k, COUNT(*) AS n, MIN("${c.name}") AS ex FROM "${name}" WHERE "${c.name}" IS NOT NULL AND typeof("${c.name}") NOT IN ('${want}'${want === 'real' ? ", 'integer'" : ''}) GROUP BY 1`).all();
        for (const r of rows) console.log(`${name}.${c.name} (${t}): ${r.n} ${r.k} value(s), e.g. ${String(r.ex).slice(0, 40)}`);
    }
}
