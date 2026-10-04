'use strict';
/** Exercise the test service lifecycle with a Docker stub; no containers are started. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./helpers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-test-services-'));
const trace = path.join(dir, 'docker.log');
fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect' && args[1] === '-f') console.log(process.env.TEST_SHM || 1073741824);
if (args[0] === 'ps') console.log('ovsdk-pg\\novsdk-pgbouncer\\novsdk-valkey');
if (args[0] === 'exec' && args.includes('psql')) {
  const sql = args.at(-1);
  if (sql.includes('pg_database_size')) console.log(6 * 1024 ** 3);
  if (sql.includes('pg_stat_activity')) console.log(process.env.TEST_BUSY || '0');
  if (sql.startsWith('DROP DATABASE') && process.env.TEST_RACE) process.exit(1);
}
` , { mode: 0o755 });

function up(extra = {}) {
    fs.writeFileSync(trace, '');
    const result = spawnSync('bash', [path.join(__dirname, '../scripts/test-services.sh'), 'up'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_TRACE: trace, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /export OV_TEST_PG_URL=/);
    return fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
}

run([
    ['a busy ovtest database is not rebuilt, including connections owned by ov', () => {
        const calls = up({ TEST_BUSY: '1' });
        const query = calls.find((a) => a.some((x) => x.includes('pg_stat_activity')));
        assert.ok(query); assert.match(query.at(-1), /datname = 'ovtest'/);
        assert.doesNotMatch(query.at(-1), /usename/);
        assert.equal(calls.some((a) => a.some((x) => x.startsWith('DROP DATABASE'))), false);
    }],
    ['an idle oversized database is rebuilt', () => {
        const calls = up({ TEST_BUSY: '0' });
        assert.ok(calls.some((a) => a.at(-1) === 'DROP DATABASE ovtest'));
        assert.ok(calls.some((a) => a.at(-1) === 'CREATE DATABASE ovtest OWNER ov'));
    }],
    ['a new connection during the drop prevents rebuilding the database', () => {
        const calls = up({ TEST_BUSY: '0', TEST_RACE: '1' });
        const drop = calls.find((a) => a.some((x) => x.startsWith('DROP DATABASE')));
        assert.ok(drop); assert.equal(drop.at(-1), 'DROP DATABASE ovtest');
        assert.equal(calls.some((a) => a.some((x) => x.startsWith('CREATE DATABASE'))), false);
    }],
    ['replacing a small-shm container removes its anonymous volume', () => {
        const calls = up({ TEST_SHM: '67108864', TEST_BUSY: '1' });
        assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('-v') && a.includes('ovsdk-pg') && a.includes('ovsdk-pgbouncer')));
    }],
]);
