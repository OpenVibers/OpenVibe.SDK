#!/usr/bin/env python3
"""The shared, non-codemod edits of a content product's PostgreSQL pass (Blog-shaped services: server/app.js createApp,
server/events/outbox.js, server/http/actor-limits.js, server/observability.js, test/helpers/boot.js).
usage: g1pass.py <svc> <Name> <ENVPREFIX>   (e.g. news News NEWS), run in the service's checkout. Idempotent-ish: each
edit asserts its anchor and skips when already applied."""
import json, re, sys, os
svc, Name, ENV = sys.argv[1], sys.argv[2], sys.argv[3]
def edit(p, pairs, required=True):
    if not os.path.exists(p): print('skip (missing)', p); return
    s = open(p).read(); o = s
    for a, b in pairs:
        if b in s: continue   # applied already (b may contain a)
        if a not in s:
            if required: raise SystemExit(f'{p}: anchor not found: {a[:90]}')
            continue
        s = s.replace(a, b, 1)
    if s != o: open(p, 'w').write(s); print('edited', p)
# package.json: the PostgreSQL stack and the pins it needs
pkg = json.load(open('package.json'))
tag = lambda repo, v: f'https://codeload.github.com/OpenVibers/{repo}/tar.gz/refs/tags/{v}'
d = pkg['dependencies']
d['openvibe-sdk'] = tag('OpenVibe.SDK', os.environ.get('G1_SDK', 'v0.20.0'))
if 'openvibe-publishing' in d: d['openvibe-publishing'] = tag('OpenVibe.Publishing', os.environ.get('G1_PUBLISHING', 'v1.0.0'))
if 'openvibe-contracts' in d: d['openvibe-contracts'] = tag('OpenVibe.Contracts', os.environ.get('G1_CONTRACTS', 'v0.76.0'))
d.setdefault('pg', '^8.23.0'); d.setdefault('iovalkey', '^0.4.0')
pkg['dependencies'] = dict(sorted(d.items()))
pkg.setdefault('devDependencies', {})['@electric-sql/pglite'] = '^0.5.8'
pkg['scripts']['test:pg'] = f'{ENV}_TEST_STORE=pg node test/run.js'
open('package.json', 'w').write(json.dumps(pkg, indent=2) + '\n'); print('package.json')
# config
edit('server/config.js', [(f"        dbPath: env.{ENV}_DB_PATH || './data/{svc}.db',", f"""        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: {{ url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '' }},
        valkey: {{ url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:{svc}:' }},
        // The SQLite file of releases before the switch: read once by scripts/migrate-to-postgres.js.
        dbPath: env.{ENV}_DB_PATH || './data/{svc}.db',""")])
# outbox
if os.path.exists('server/events/outbox.js'):
  edit('server/events/outbox.js', [
    ("const { createEventsClient, createOutbox } = require('openvibe-sdk/events');", "const { createEventsClient, createPgOutbox } = require('openvibe-sdk/events');"),
    ("    const outbox = createOutbox(db, {", "    // The PostgreSQL outbox: rows are written in the change's own transaction (enqueue(db, …) joins the ambient\n    // transaction); several processes relay one table safely (leases).\n    const outbox = createPgOutbox(db, {"),
])
s = open('server/events/outbox.js').read()
s2 = re.sub(r"\n[ \t]*(await )?outbox\.ensureSchema\(\);[^\n]*", '', s)
if s2 != s: open('server/events/outbox.js', 'w').write(s2); print('outbox: schema is the migration now')
s = open('server/events/outbox.js').read()
s2 = re.sub(r'outbox\.enqueue\((?!db, )', 'outbox.enqueue(db, ', s)
if s2 != s: open('server/events/outbox.js', 'w').write(s2); print('enqueue(db, …)')
# app.js store
s = open('server/app.js').read()
m = re.search(r"    const store = opts\.store \|\| openStore\(opts\.dbPath \|\| config\.dbPath, \{ now: opts\.now(, [^}]*)? \}\);", s)
if m:
    s = s.replace(m.group(0), "    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.\n    const store = opts.store || await openStore(config, { now: opts.now, log });")
    s = s.replace('function createApp(opts = {}) {', 'async function createApp(opts = {}) {', 1)
    open('server/app.js', 'w').write(s); print('app store')
# limits + valkey
edit('server/http/actor-limits.js', [
    ("const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');", "const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');"),
    ("function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {", "function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, valkey = null }) {"),
    ("        now,\n", "        now,\n        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.\n        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),\n"),
])
s = open('server/app.js').read()
m = re.search(r"    ctx\.(limits|actorLimits) = createActorLimits\(\{ config, now: opts\.limitsNow \|\| \(\(\) => Date\.now\(\)\), registry: metrics\.registry, log \}\);", s)
if m:
    s = s.replace(m.group(0), "    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.\n    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);\n    ctx.valkey = valkey;\n    ctx." + m.group(1) + " = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });")
    open('server/app.js', 'w').write(s); print('app valkey')
# readiness
s = open('server/observability.js').read(); o = s
s = re.sub(r"(function create\w+Readiness\(\{ store, [^}]*?)(, release = null \}\))", lambda m: m.group(1) + (', valkey = null' if 'valkey' not in m.group(1) else '') + m.group(2), s, 1)
s = s.replace("""            {
                name: 'network_jwks', required: false,""", """            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,""", 1) if "name: 'valkey'" not in s else s
s = re.sub(r"""const names = new Set\((?:\(await )?db\.prepare\("SELECT name FROM sqlite_master WHERE type IN \('table','view'\)"\)\.all\(\)\)?\.map\(\(r\) => r\.name\)\);\n(\s*)const missing = CHARTER_TABLES\.filter\(\(t\) => !names\.has\(t\)\);\n\s*return missing\.length \? `missing \$\{missing\.join\(', '\)\}` : true;""",
    lambda m: f"""// A real round trip that names the store (postgresql / pglite), and the charter tables present.
{m.group(1)}const r = await db.ready();
{m.group(1)}if (!r.ok) return r.error;
{m.group(1)}const names = new Set((await db.prepare('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()').all()).map((x) => x.name));
{m.group(1)}const missing = CHARTER_TABLES.filter((t) => !names.has(t));
{m.group(1)}return missing.length ? `missing ${{missing.join(', ')}} (migrations did not run)` : {{ ok: true, detail: r.detail }};""", s)
s = s.replace("check: () => {\n                    // A real round trip", "check: async () => {\n                    // A real round trip")
if s != o: open('server/observability.js', 'w').write(s); print('readiness')
s = open('server/app.js').read()
s2 = re.sub(r"(create\w+Readiness\(\{ store, [^}]*?release: release\.release)( \}\))", lambda m: m.group(1) + (', valkey: ctx.valkey' if 'valkey' not in m.group(1) else '') + m.group(2), s, 1)
if s2 != s: open('server/app.js', 'w').write(s2); print('app readiness')
# index.js: await createApp
s = open('server/index.js').read()
if 'await createApp()' not in s:
    s = s.replace("const { app, ctx } = createApp();", "(async () => {\nconst { app, ctx } = await createApp();", 1)
    s = s.replace("        try { ctx.store.close(); } catch { /* already closed */ }", "        try { await ctx.store.close(); } catch { /* already closed */ }")
    s = s.replace(f"(db ${{config.dbPath}})", "(db ${ctx.store.db.store})")
    s = s.rstrip() + f"\n}})().catch((err) => {{ console.error('[{Name}] failed to start:', err); process.exit(1); }});\n"
    open('server/index.js', 'w').write(s); print('index')
# test helpers
os.makedirs('test/helpers', exist_ok=True)
open('test/helpers/db.js', 'w').write(f"""'use strict';
/**
 * A migrated database for one test run (ADR-035), from openvibe-sdk/testing: PGlite by default; with
 * {ENV}_TEST_STORE=pg (npm run test:pg) the PostgreSQL + PgBouncer containers, with roles and a schema of this run's own.
 */
const {{ createTestDb, pgAvailable }} = require('openvibe-sdk/testing');
const {{ MIGRATIONS }} = require('../../server/db');

const testDb = ({{ store = process.env.{ENV}_TEST_STORE || 'pglite', max = 4 }} = {{}}) => createTestDb({{ migrations: MIGRATIONS, store, service: '{svc}', max }});

module.exports = {{ testDb, pgAvailable }};
""")
s = open('test/helpers/boot.js').read(); o = s
if "require('./db').testDb()" not in s:
    s = s.replace("    let server = null;\n    let built = null;", "    const { createStore } = require('../../server/db');\n    // One database per boot (PGlite, or " + ENV + "_TEST_STORE=pg: the containers); a restart keeps it, like a file did.\n    const testdb = await require('./db').testDb();\n    let server = null;\n    let built = null;", 1)
    s = re.sub(r"built = createApp\(\{ config, ", "built = await createApp({ config, store: createStore(testdb.db, { now: clock.now }), ", s, 1)
    s = re.sub(r"(await built\.ctx\.outbox\.stop\(\);) built\.ctx\.store\.close\(\);", r"\1", s)
    s = re.sub(r"    function events\(type = null\) \{\n        return t\.ctx\.store\.db\.prepare\('SELECT envelope FROM event_outbox ORDER BY id'\)\.all\(\)\.map\(\(r\) => JSON\.parse\(r\.envelope\)\)",
               "    async function events(type = null) {\n        return (await t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))", s)
    s = s.replace("        async close() { await stop(); await network.close();", "        async close() { await stop(); await testdb.close(); await network.close();", 1)
if s != o: open('test/helpers/boot.js', 'w').write(s); print('boot helper')
# CI, unit, env, import script
s = open('.github/workflows/ci.yml').read()
if 'test-services.sh' not in s:
    s = s.replace(f"      contracts-service: {svc}\n", f"""      contracts-service: {svc}
      # ADR-035: PostgreSQL 18 + PgBouncer (transaction mode) + Valkey 9 containers (openvibe-sdk
      # scripts/test-services.sh). npm test runs every file on PGlite; test:pg runs them all through PgBouncer.
      test: 'eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm test && npm run test:pg'
""", 1); open('.github/workflows/ci.yml', 'w').write(s); print('ci')
unit = f'deploy/systemd/openvibe-{svc}.service'
edit(unit, [("After=network.target\n", "After=network.target postgresql.service pgbouncer.service valkey-server.service\n"), ("Wants=openvibe-network.service\n", "Wants=openvibe-network.service postgresql.service pgbouncer.service valkey-server.service\n")], required=False)
edit('.env.example', [(f"{ENV}_DB_PATH=./data/{svc}.db", f"""# PostgreSQL (ADR-035), written by OpenVibe.Host roles/data/add-service.sh {svc}: the runtime role through PgBouncer,
# the owner on a direct connection (migrations and the one-time import), and Valkey (shared limit counters).
# Without DATABASE_URL, development uses an embedded PGlite database in data/pglite.
DATABASE_URL=
DATABASE_DIRECT_URL=
VALKEY_URL=
VALKEY_PREFIX=
# The SQLite file of releases before PostgreSQL: read once by scripts/migrate-to-postgres.js.
{ENV}_DB_PATH=./data/{svc}.db""")], required=False)
os.makedirs('scripts', exist_ok=True)
cfgmod = "require('../server/config')"
open('scripts/migrate-to-postgres.js', 'w').write(f"""#!/usr/bin/env node
'use strict';
/**
 * The one-time move of {Name}'s SQLite database ({ENV}_DB_PATH) into its PostgreSQL schema (ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by openvibe-sdk/db runSqliteMigration).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 * Applies migrations/ as the owner (DATABASE_DIRECT_URL), copies every table into emptied tables, verifies row counts
 * and checksums, and exits 1 unless everything verified. The SQLite file is opened read-only. Every table keeps its
 * name and columns.
 */
require('dotenv').config();
const {{ runSqliteMigration }} = require('openvibe-sdk/db');
const configLib = {cfgmod};
const {{ MIGRATIONS }} = require('../server/db');

const TABLES = {{}};

if (require.main === module) {{
    const config = configLib.load();
    runSqliteMigration({{ service: '{svc}', sqlite: config.dbPath, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES }})
        .then((code) => process.exit(code), (err) => {{ console.error(`migrate-to-postgres failed: ${{err.message}}`); process.exit(1); }});
}}

module.exports = {{ TABLES }};
""")
print('done')
