'use strict';
/** runSqliteMigration: migrate, import, clean what PostgreSQL refuses (NUL, unpaired surrogates) and report it,
 *  verify, answer 0; a column the schema lacks is a problem and answers 1; --json prints the report. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./helpers');
const { runSqliteMigration } = require('../src/db');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-sqlitecli-'));
const migrations = path.join(dir, 'migrations');
fs.mkdirSync(migrations);
fs.writeFileSync(path.join(migrations, '0001_initial.sql'), `-- phase: expand
CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL, meta jsonb, created_at bigint NOT NULL);
CREATE TABLE renamed (id text PRIMARY KEY, n integer NOT NULL);
`);

function sqliteFile(extraColumn = false) {
    const file = path.join(dir, `src-${extraColumn ? 'x' : 'ok'}.db`);
    const db = new Database(file);
    db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL${extraColumn ? ', stray TEXT' : ''});
             CREATE TABLE old_name (id TEXT PRIMARY KEY, n INTEGER NOT NULL);`);
    const ins = db.prepare('INSERT INTO notes (body, meta, created_at) VALUES (?, ?, ?)');
    ins.run('plain', '{"a":1}', 1);
    ins.run('with\u0000nul', '{"k":"bad \\ud800 surrogate"}', 2);
    ins.run('none', null, 3);
    db.prepare('INSERT INTO old_name (id, n) VALUES (?, ?)').run('x', 7);
    db.close();
    return file;
}

const tests = [];
if (Database) {
    tests.push(['imports, cleans and reports, verifies and answers 0', async () => {
        const lines = [];
        const code = await runSqliteMigration({ service: 'sdk', sqlite: sqliteFile(), migrations, tables: { renamed: { from: 'old_name' } }, argv: ['--pglite'], out: (l) => lines.push(l) });
        assert.equal(code, 0, lines.join('\n'));
        assert.match(lines[0], /→ pglite .*: OK/);
        assert.ok(lines.some((l) => /notes .* 3 rows/.test(l)));
        assert.ok(lines.some((l) => /renamed .* 1 rows .*\(from old_name\)/.test(l)));
        assert.ok(lines.some((l) => /cleaned: notes\.body: 1 value/.test(l)), lines.join('\n'));
        assert.ok(lines.some((l) => /cleaned: notes\.meta: 1 value/.test(l)), lines.join('\n'));
    }]);
    tests.push(['a column the schema lacks is a problem: answers 1; --json prints the report', async () => {
        const lines = [];
        const code = await runSqliteMigration({ service: 'sdk', sqlite: sqliteFile(true), migrations, tables: { renamed: { from: 'old_name' } }, argv: ['--pglite', '--json'], out: (l) => lines.push(l) });
        assert.equal(code, 1);
        const report = JSON.parse(lines.join('\n'));
        assert.equal(report.ok, false);
        assert.ok(report.problems.some((p) => p.table === 'notes' && /stray/.test(p.problem)), JSON.stringify(report.problems));
    }]);
} else console.log('runSqliteMigration: skipped (better-sqlite3 not installed)');

run(tests);
