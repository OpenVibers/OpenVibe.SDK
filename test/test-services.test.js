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
    ['up preserves a reused database even when no test has an open query connection', () => {
        const calls = up();
        assert.equal(calls.some((a) => a.includes('psql') || a.includes('rm')), false);
    }],
    ['replacing a small-shm container removes its anonymous volume', () => {
        const calls = up({ TEST_SHM: '67108864' });
        assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('-v') && a.includes('ovsdk-pg') && a.includes('ovsdk-pgbouncer')));
    }],
]);
