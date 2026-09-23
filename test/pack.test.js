'use strict';
/**
 * `npm pack`, install the tarball into a fresh project (offline: the package has no runtime
 * dependencies), then require and import every subpath from there, as a consumer would.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pkg = require('../package.json');

run([
    ['the tarball installs and every subpath loads (CJS and ESM)', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openvibe-sdk-pack-'));
        try {
            const env = { ...process.env, npm_config_cache: path.join(tmp, '.npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
            const out = execFileSync(npm, ['pack', '--json', '--pack-destination', tmp], { cwd: ROOT, env, encoding: 'utf8' });
            const info = JSON.parse(out)[0];
            const files = info.files.map((f) => f.path);
            for (const must of ['package.json', 'index.js', 'browser.js', 'LICENSE', 'README.md', 'CHANGELOG.md', 'src/core/client.js', 'src/jobs.js', 'src/projects.js', 'esm/core.mjs', 'esm/jobs.mjs', 'types/core.d.ts', 'types/contracts.d.ts', 'types/bundle.d.ts', 'browser/openvibe-sdk.mjs']) {
                assert.ok(files.includes(must), `tarball contains ${must}`);
            }
            assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('scripts/') || f.startsWith('.github/')), 'no tests or tooling in the tarball');

            const app = path.join(tmp, 'app');
            fs.mkdirSync(app);
            fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'sdk-consumer', version: '1.0.0', private: true }));
            execFileSync(npm, ['install', '--offline', '--no-package-lock', path.join(tmp, info.filename)], { cwd: app, env, stdio: 'pipe' });

            const subpaths = Object.keys(pkg.exports).filter((s) => s !== './package.json' && !s.endsWith('.mjs')).map((s) => (s === '.' ? 'openvibe-sdk' : `openvibe-sdk/${s.slice(2)}`));
            const script = `
                const assert = require('node:assert/strict');
                const specs = ${JSON.stringify(subpaths)};
                (async () => {
                    for (const s of specs) {
                        const c = require(s);
                        const e = await import(s);
                        assert.ok(Object.keys(c).length, s);
                        assert.equal(e.default, c, s);
                    }
                    const { createClient } = require('openvibe-sdk/core');
                    const { createMockPlatform } = require('openvibe-sdk/testing');
                    const { createServiceTokenClient } = require('openvibe-sdk/auth');
                    const { createMediaClient } = require('openvibe-sdk/media');
                    const platform = createMockPlatform({ clients: { app: { secret: 's', grants: [['media.object.upload', 'openvibe.media', ['app']]] } }, mediaApps: { app: {} } });
                    const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'app', clientSecret: 's', fetch: platform.fetch }) });
                    const f = await createMediaClient(client, { app: 'app' }).upload('hi', { filename: 'a.txt' });
                    assert.match(f.key, /-a\\.txt$/);
                    assert.equal(require('openvibe-sdk/package.json').version, ${JSON.stringify(pkg.version)});
                    assert.equal(require('openvibe-sdk/core').SDK_VERSION, ${JSON.stringify(pkg.version)});
                    const bundle = await import('openvibe-sdk/browser/openvibe-sdk.mjs');
                    assert.equal(bundle.SDK_VERSION, ${JSON.stringify(pkg.version)});
                    assert.equal(typeof bundle.jobs.createJobsClient, 'function');
                    assert.equal(typeof require.resolve('openvibe-sdk/browser/openvibe-sdk.mjs'), 'string');
                    console.log('consumer ok: ' + specs.length + ' subpaths + the browser bundle');
                })().catch((err) => { console.error(err); process.exit(1); });`;
            const res = execFileSync(process.execPath, ['-e', script], { cwd: app, encoding: 'utf8' });
            assert.match(res, new RegExp(`consumer ok: ${subpaths.length} subpaths \\+ the browser bundle`));
            assert.equal(subpaths.length, 14);
            assert.ok(!fs.existsSync(path.join(app, 'node_modules/openvibe-contracts')), 'the optional peer is not installed');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }],
]);
