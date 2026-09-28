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
    (r'(@\w+|[^\w]\?) IS (NOT )?NULL(?!::)', 'a parameter tested with IS NULL may need a cast (@p::bigint IS NULL) when PostgreSQL cannot infer its type'),
    (r'UNIQUE constraint|constraint failed|SQLITE_[A-Z]', "SQLite error text → err.code ('23505' unique, '23503' foreign key, '23514' check) with err.table/err.constraint/err.detail"),
]
changed = []
for p in files:
    s = open(p).read(); o = s
    while 'INSERT OR IGNORE INTO' in s:
        i = s.index('INSERT OR IGNORE INTO'); q = s[i - 1] if s[i - 1] in '\'"`' else '`'
        j = s.index(q, i)
        s = s[:i] + 'INSERT INTO' + s[i + len('INSERT OR IGNORE INTO'):j] + ' ON CONFLICT DO NOTHING' + s[j:]
    s = re.sub(r'([\w.]+) COLLATE NOCASE', r'lower(\1)', s)
    s = re.sub(r'(?<![IN\w])LIKE (?=[@?:$\'(]|[a-z])', 'ILIKE ', s)
    s = s.replace('json_each(?)', 'jsonb_array_elements_text(?::jsonb)')
    s = re.sub(r'\bIFNULL\(', 'COALESCE(', s)
    # ON CONFLICT … DO UPDATE SET x = x + 1 / COALESCE(excluded.x, x): a bare column on the right is ambiguous in
    # PostgreSQL; qualify it with the table (columns of the INSERT list only; excluded.x and the targets stay).
    def qualify(m):
        table, cols, rest = m.group(1), [c.strip() for c in m.group(2).split(',')], m.group(3)
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
