'use strict';
/** Exercise the test service lifecycle with a Docker stub; no containers are started. Without a working Docker the
 *  script starts the services from local binaries (a shared node's check job); here it finds none and says so. */
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
if (args[0] === 'info' && process.env.DOCKER_INFO_FAIL) process.exit(1);
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

function upLocal(extra = {}) {
    fs.writeFileSync(trace, '');
    const empty = fs.mkdtempSync(path.join(dir, 'no-bins-'));
    const result = spawnSync('bash', [path.join(__dirname, '../scripts/test-services.sh'), 'up'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_TRACE: trace, OV_TEST_SERVICES_PATH: empty,
            OV_TEST_SERVICES_DIR: path.join(dir, 'services'), ...extra },
    });
    return { result, calls: fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

run([
    ['without a working Docker, up starts nothing in Docker and names the local services it needs', () => {
        const { result, calls } = upLocal({ DOCKER_INFO_FAIL: '1' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no Docker, and no local postgresql-18 pgbouncer valkey-server/);
        assert.equal(result.stdout, '');
        assert.equal(calls.some((a) => a[0] === 'run'), false);
    }],
    ['OV_TEST_SERVICES=local skips Docker even when it answers; =docker keeps it', () => {
        const local = upLocal({ OV_TEST_SERVICES: 'local' });
        assert.equal(local.result.status, 1);
        assert.deepEqual(local.calls, []);
        const docker = upLocal({ OV_TEST_SERVICES: 'docker', DOCKER_INFO_FAIL: '1' });
        assert.equal(docker.result.status, 0, docker.result.stderr);
        assert.match(docker.result.stdout, /export OV_TEST_PG_URL=postgres:\/\/ov:ovtestpw@127\.0\.0\.1:56432\/ovtest/);
    }],
    ['up preserves a reused database even when no test has an open query connection', () => {
        const calls = up();
        assert.equal(calls.some((a) => a.includes('psql') || a.includes('rm')), false);
    }],
    ['replacing a small-shm container removes its anonymous volume', () => {
        const calls = up({ TEST_SHM: '67108864' });
        assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('-v') && a.includes('ovsdk-pg') && a.includes('ovsdk-pgbouncer')));
    }],
]);
