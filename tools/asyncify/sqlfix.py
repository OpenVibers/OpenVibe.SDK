#!/usr/bin/env python3
"""The SQLite → PostgreSQL SQL rewrites that are safe to do by text (ADR-035), over a service's server/, scripts/ and
test/ files; and a report of what needs a person.
usage: sqlfix.py [files…]   (default: git ls-files server scripts test, *.js)

Rewrites:
  INSERT OR IGNORE INTO t … → INSERT INTO t … ON CONFLICT DO NOTHING   (at the end of that string literal)
  x COLLATE NOCASE          → lower(x)
  LIKE / NOT LIKE           → ILIKE / NOT ILIKE   (SQLite's LIKE ignores ASCII case)
  json_each(?)              → jsonb_array_elements_text(?::jsonb)   (a JSON text parameter; column "value")
  IFNULL(                   → COALESCE(
  db.transaction(fn)()      → db.tx(fn);   db.inTransaction → db.inTransaction()
  sqlite_master table lists → information_schema.tables of the current schema
  pragma_table_info('t')    → information_schema.columns of t
  sequencer.stamp(doc)      → sequencer.stamp(store.db, doc)   (openvibe-publishing 1.0)
Reported (fix by hand): INSERT OR REPLACE, rowid, scalar MAX(a, b)/MIN(a, b), HAVING on an alias, WITH RECURSIVE (the
seed needs the column's collation), datetime/strftime/julianday, IFNULL, GROUP_CONCAT, json_extract, lastInsertRowid,
.transaction(, setImmediate/nextTick near a transaction, createInbox, PRAGMA."""
import re, subprocess, sys
files = sys.argv[1:] or [f for f in subprocess.run(['git', 'ls-files', 'server', 'scripts', 'test'], capture_output=True, text=True).stdout.split() if f.endswith('.js')]
REPORT = [
    (r'INSERT OR REPLACE', 'INSERT OR REPLACE → ON CONFLICT (key) DO UPDATE SET … (qualify the target columns)'),
    (r'\browid\b', 'rowid → a seq identity column'),
    (r'\b(MAX|MIN)\(\s*[\w.]+\s*,', 'scalar MAX/MIN → GREATEST/LEAST'),
    (r'HAVING\s+[a-z_]+\s*[<>=!]', 'HAVING on an alias → repeat the aggregate'),
    (r'SELECT DISTINCT', 'SELECT DISTINCT with ORDER BY on an expression not selected fails; a DISTINCT over a LEFT JOIN is usually WHERE … OR EXISTS (…)'),
    (r'GROUP BY', 'GROUP BY: every selected bare column must be grouped (SQLite took a bare column from the MAX/MIN row: DISTINCT ON)'),
    (r'WITH RECURSIVE', 'recursive seed: cast ? to the column type and collation (?::text COLLATE "C")'),
    (r"datetime\(|strftime\(|julianday\(", 'SQLite date functions'),
    (r'GROUP_CONCAT|json_extract|json_group_array|json_object\(', 'SQLite functions'),
    (r'lastInsertRowid', 'lastInsertRowid → RETURNING'),
    (r'\.transaction\(', 'db.transaction(fn)() → db.tx(fn)'),
    (r'setImmediate|process\.nextTick', 'deferred work: after a commit → db.afterCommit'),
    (r'createInbox\b', 'createInbox → createPgInbox (awaited; receipts table in the migration)'),
    (r'\bPRAGMA\b|\.pragma\(', 'PRAGMA'),
    (r'\b(db|this\.db)\.exec\(', 'DDL at boot on the serving handle: the serving role cannot create tables; the table belongs in a migration'),
    (r'\b(SUM|AVG)\((?![^)]*\bCASE\b)[^)]*\)(?!\s*::)(?!, *0\)::)', 'SUM/AVG of a bigint column is numeric, returned as text: cast it (COALESCE(SUM(x), 0)::bigint) unless the column is double precision'),
    (r'(@\w+|[^\w]\?) IS (NOT )?NULL(?!::)', 'a parameter tested with IS NULL may need a cast (@p::bigint IS NULL) when PostgreSQL cannot infer its type'),
    (r'UNIQUE constraint|constraint failed|SQLITE_[A-Z]', "SQLite error text → err.code ('23505' unique, '23503' foreign key, '23514' check) with err.table/err.constraint/err.detail"),
]
changed = []
# Table columns from the service's migrations, so upsert right-hand sides can be qualified even for columns the INSERT
# does not list (a counter bumped in place, a timestamp cleared).
TABLE_COLS = {}
import glob as _glob
for mf in sorted(_glob.glob('migrations/*.sql')):
    ddl = open(mf).read()
    for tm in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(([\s\S]*?)\n\);', ddl):
        cols = [c.group(1).strip('"') for c in re.finditer(r'^\s*("?\w+"?)\s+(?:text|bigint|integer|double|boolean|bytea|jsonb|timestamptz|numeric|real)', tm.group(2), re.M)]
        TABLE_COLS.setdefault(tm.group(1), set()).update(cols)
    for am in re.finditer(r'ALTER TABLE (\w+) ADD COLUMN (\w+)', ddl):
        TABLE_COLS.setdefault(am.group(1), set()).add(am.group(2))
for p in files:
    s = open(p).read(); o = s
    while 'INSERT OR IGNORE INTO' in s:
        i = s.index('INSERT OR IGNORE INTO'); q = s[i - 1] if s[i - 1] in '\'"`' else '`'
        j = s.index(q, i)
        s = s[:i] + 'INSERT INTO' + s[i + len('INSERT OR IGNORE INTO'):j] + ' ON CONFLICT DO NOTHING' + s[j:]
    s = re.sub(r'(\w+\((?:[^()]|\([^()]*\))*\)) COLLATE NOCASE', r'lower(\1)', s)   # an expression: COALESCE(a, b) COLLATE NOCASE
    s = re.sub(r'([\w.]+) COLLATE NOCASE', r'lower(\1)', s)
    s = re.sub(r'(?<![IN\w])LIKE (?=[@?:$\'(]|[a-z])', 'ILIKE ', s)
    s = s.replace('json_each(?)', 'jsonb_array_elements_text(?::jsonb)')
    s = re.sub(r'\bIFNULL\(', 'COALESCE(', s)
    # SQLite's null-safe x IS ? / x IS NOT ? (a parameter) are IS [NOT] DISTINCT FROM in PostgreSQL.
    s = re.sub(r'([\w.]+) IS NOT (\?|@\w+)', r'\1 IS DISTINCT FROM \2', s)
    s = re.sub(r'([\w.]+) IS (\?|@\w+)', r'\1 IS NOT DISTINCT FROM \2', s)
    # assert.throws(() => db.prepare(…).run(…), re): the statement rejects now.
    s = re.sub(r"assert\.throws\(\(\) => ((?:t\.)?[\w.]*db\.prepare\((?:[^()]|\([^()]*\))*\)\.(?:run|get|all)\((?:[^()]|\([^()]*\))*\)), ", r"await assert.rejects(\1, ", s)
    # A jsonb column (the SDK outbox's envelope) comes back as an object.
    s = re.sub(r"JSON\.parse\((\w+)\.envelope\)", r"(typeof \1.envelope === 'string' ? JSON.parse(\1.envelope) : \1.envelope)", s)
    # const f = db.transaction((a, b) => { … }) (called later as f(a, b)) → const f = (a, b) => db.tx(async () => { … })
    s = re.sub(r'const (\w+) = (\w+(?:\.\w+)?)\.transaction\(\(([^()]*)\) => \{', r'const \1 = (\3) => \2.tx(async () => {', s)
    # db.transaction(fn)() → db.tx(fn) (balanced parentheses; the codemod then awaits it and makes fn async).
    out, i = [], 0
    while True:
        j = s.find('.transaction(', i)
        if j < 0: out.append(s[i:]); break
        k, depth = j + len('.transaction('), 1
        while k < len(s) and depth:
            depth += {'(': 1, ')': -1}.get(s[k], 0); k += 1
        if s[k:k + 2] == '()':
            out.append(s[i:j] + '.tx(' + s[j + len('.transaction('):k]); i = k + 2
        else:
            out.append(s[i:k]); i = k
    s = ''.join(out)
    # Column names PostgreSQL reserves (SQLite does not): quoted inside SQL string literals ("window", "user").
    def quote_reserved(lit):
        body = lit.group(0)
        if not re.search(r'\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b', body): return body
        q = '\\"' if body[0] == '"' else '"'   # inside a double-quoted JS string the quotes are escaped
        return re.sub(r"(?<![.\w\"$\\'])(window|user)(?![\w\"(\\'])", lambda m: q + m.group(1) + q, body)
    s = re.sub(r'`[^`]*`|\'(?:[^\'\\\n]|\\.)*\'|"(?:[^"\\\n]|\\.)*"', quote_reserved, s)
    # better-sqlite3's db.inTransaction was a property; openvibe-sdk/db's is a function.
    s = re.sub(r'\b(db|this\.db|store\.db)\.inTransaction\b(?!\s*\()', r'\1.inTransaction()', s)
    # ON CONFLICT … DO UPDATE SET x = x + 1 / COALESCE(excluded.x, x): a bare column on the right is ambiguous in
    # PostgreSQL; qualify it with the table (columns of the INSERT list only; excluded.x and the targets stay).
    def qualify(m):
        table, cols, rest = m.group(1), [c.strip() for c in m.group(2).split(',')], m.group(3)
        cols = sorted(set(cols) | TABLE_COLS.get(table, set()), key=len, reverse=True)
        k = rest.index('DO UPDATE SET') + len('DO UPDATE SET')
        head, sets = rest[:k], rest[k:]
        def fix_rhs(a):
            lhs, eq, rhs = a.partition('=')
            if not eq: return a
            for c in cols:
                rhs = re.sub(r'(?<![.\w@:$])%s\b(?!\s*\()' % re.escape(c), f'{table}.{c}', rhs)
            return lhs + eq + rhs
        parts = re.split(r'(,\s*(?=\w+\s*=))', sets)
        return f'INSERT INTO {table} ({m.group(2)}){head}' + ''.join(fix_rhs(x) if not re.match(r',\s*$', x) else x for x in parts)
    s = re.sub(r'INSERT INTO (\w+) \(([^)]*)\)((?:(?!INSERT INTO)[^`\'"])*?DO UPDATE SET[^`\'"]*)', qualify, s)
    # openvibe-publishing 1.0: the index sequencer stamps through a handle (the ambient transaction joins through store.db).
    handle = 'store.db' if 'store.db' in s else 'db'
    s = re.sub(r'((?:store\.)?sequencer\.stamp\()(?!store\.db|db,|t,)', lambda m: m.group(1) + handle + ', ', s)
    s = re.sub(r"(SELECT name FROM sqlite_master WHERE type (?:= 'table'|IN \('table', ?'view'\))) AND name NOT (?:I)?LIKE 'sqlite_%'", r"\1", s)
    s = re.sub(r"SELECT name FROM sqlite_master WHERE type (?:= 'table'|IN \('table', ?'view'\))",
               "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()", s)
    s = re.sub(r"SELECT name FROM pragma_table_info\('(\w+)'\)",
               r"SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '\1' ORDER BY ordinal_position", s)
    if s != o: open(p, 'w').write(s); changed.append(p)
    for n, line in enumerate(s.split('\n'), 1):
        for pat, why in REPORT:
            if re.search(pat, line) and not line.lstrip().startswith(('//', '*')):
                print(f'CHECK {p}:{n}: {why}: {line.strip()[:120]}')
print('rewrote: ' + (', '.join(changed) or 'nothing'))
