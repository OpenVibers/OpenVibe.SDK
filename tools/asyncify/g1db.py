#!/usr/bin/env python3
"""server/db.js of a Blog-shaped service, from better-sqlite3 to openvibe-sdk/db (ADR-035): openDb (DATABASE_URL through
PgBouncer, migrations as the owner, PGlite in development), createStore (the stores openStore returned, on the async
handle) and openStore(config). The SCHEMA literal goes (it is migrations/0001_initial.sql now: gen-migration.js).
usage: g1db.py <svc> <Name>   run in the service's checkout after gen-migration.js."""
import re, sys
svc, Name = sys.argv[1], sys.argv[2]
p = 'server/db.js'
s = open(p).read()
if 'openvibe-sdk/db' in s: sys.exit('server/db.js is converted already')
m = re.search(r"\nfunction openStore\(dbPath, \{ now = \(\) => Date\.now\(\) \} = \{\}\) \{\n[\s\S]*?\n    return \{\n([\s\S]*?)\n    \};\n\}\n", s)
if not m: sys.exit('openStore(dbPath, { now }) with a returned object literal not found: convert by hand')
props = [l for l in m.group(1).split('\n') if not re.match(r"\s+(db|now|tx: .*|close: .*),?$", l)]
doc = s.rfind('/**', 0, m.start() + 1)
end = s.find('*/', doc) if doc != -1 else -1
# openStore's own doc comment only: the comment must end right before the function (whitespace between).
head = s[:doc] if doc != -1 and end != -1 and not s[end + 2:m.start() + 1].strip() else s[:m.start() + 1]
tail = s[m.end():]
head = re.sub(r"const Database = require\('better-sqlite3'\);\n", "const { createDb } = require('openvibe-sdk/db');\n", head)
head = re.sub(r"\nconst SCHEMA = `[\s\S]*?`;\n", "\nconst MIGRATIONS = path.join(__dirname, '..', 'migrations');\nconst DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');\n", head)
head = re.sub(r"(%s'?s?) own SQLite database(?: \(WAL\))?[:,] created on boot, idempotently\." % re.escape(Name),
              lambda x: x.group(1) + " own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot.", head)
body = f"""/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, {{ log = console, registry }} = {{}}) {{
    if (!config.db.url) {{
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh {svc})');
        log.warn(`[{Name}] DATABASE_URL unset: embedded PGlite database in ${{DEV_PGLITE}} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, {{ recursive: true }});
        const db = createDb({{ pglite: DEV_PGLITE, service: '{svc}', registry, log }});
        await db.migrate({{ dir: MIGRATIONS, log }});
        return db;
    }}
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({{ url: config.db.directUrl, service: '{svc}-migrate', max: 1, log }});
    try {{ await owner.migrate({{ dir: MIGRATIONS, log }}); }} finally {{ await owner.close(); }}
    return createDb({{ url: config.db.url, service: '{svc}', registry, log }});
}}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, {{ now = () => Date.now() }} = {{}}) {{
    return {{
        db,
        now,
{chr(10).join(props)}
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    }};
}}

/** openDb + createStore. */
async function openStore(config, {{ now, log }} = {{}}) {{
    return createStore(await openDb(config, {{ log }}), {{ now }});
}}
"""
tail = re.sub(r"module\.exports = \{ openStore(, )?", r"module.exports = { openDb, openStore, createStore, MIGRATIONS\1", tail)
s = head + body + tail
open(p, 'w').write(s)
print('server/db.js converted; stores kept:', ', '.join(re.findall(r"^\s+(\w+):", '\n'.join(props), re.M)) or 'none')
