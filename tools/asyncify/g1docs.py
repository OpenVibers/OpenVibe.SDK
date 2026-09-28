#!/usr/bin/env python3
"""README.md and STATUS.json edits after a service's PostgreSQL pass (the wording Blog, News and Deals use).
usage: g1docs.py <svc> <Name> <ENVPREFIX>   run in the service's checkout, after package.json has the new pins.
Each edit is skipped when its anchor is missing (it prints what it could not place, for a hand edit)."""
import json, re, sys
svc, Name, ENV = sys.argv[1], sys.argv[2], sys.argv[3]
pkg = json.load(open('package.json'))
ver = lambda n: (re.search(r'/v([0-9.]+)$', pkg['dependencies'].get(n, '')) or [None, None])[1]
s = open('README.md').read(); o = s
miss = []
def sub(pattern, repl, flags=0, what=''):
    global s
    n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n[1]: s = n[0]
    else: miss.append(what or pattern[:60])
sub(r"live in %s'?s? own SQLite \(`%s_DB_PATH`\)" % (re.escape(Name), ENV),
    f"live in {Name}' own PostgreSQL database (`ov_{svc}` on the host's data role, ADR-035; schema in [migrations/](migrations/))", what='tables line')
if 'PostgreSQL 18 and Valkey 9' not in s:
    sub(r"\n- \*\*Packages\*\*", "\n- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through\n  `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional: without `VALKEY_URL` they count per process).\n- **Packages**", what='PG bullet')
for name in ['openvibe-publishing', 'openvibe-contracts', 'openvibe-sdk', 'openvibe-shared']:
    v = ver(name)
    if v: s = re.sub(r"(`%s`\s+)v[0-9.]+" % re.escape(name), r"\g<1>v" + v, s)
s = s.replace('(chrome, app icon', '(Frame, app icon')
unit = re.search(r"The unit is `openvibe-%s\.service` on `[^`]+`, the env file `/etc/openvibe/%s\.env`\." % (svc, svc), s)
if unit and 'add-service.sh' not in s:
    s = s[:unit.end()] + f""" The database is
`ov_{svc}` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh {svc}` writes its settings); the
release migrates it at boot. The one-time move from SQLite is `scripts/migrate-to-postgres.js` (openvibe-sdk
`runSqliteMigration`, with a `--pglite` rehearsal mode), run while the service is stopped; the old
`/var/lib/openvibe-{svc}/{svc}.db` stays read-only for 7 days as the rollback.""" + s[unit.end():]
elif not unit: miss.append('unit paragraph')
s = re.sub(r"Nothing blocks a rollback: the schema\s+code only adds tables and columns\.", "Migrations only add tables and columns.", s)
if s != o: open('README.md', 'w').write(s)
st = json.load(open('STATUS.json'))
st['runtime'] = re.sub(r'better-sqlite3 \d+', 'PostgreSQL 18 (openvibe-sdk/db, async) + Valkey 9', st.get('runtime', ''))
if ver('openvibe-contracts'): st['contracts'] = f"openvibe-contracts v{ver('openvibe-contracts')}"
if 'packages' in st:
    st['packages'] = [f"{n} v{ver(n)}" if ver(n) else p for p in st['packages'] for n in [p.split(' ')[0]]]
open('STATUS.json', 'w').write(json.dumps(st, indent=2, ensure_ascii=False) + '\n')
left = [l for l in s.splitlines() if re.search(r'SQLite|better-sqlite3', l)]
print('README/STATUS updated' + (f"; not placed: {', '.join(miss)}" if miss else ''))
for l in left: print('  still says SQLite:', l[:140])
