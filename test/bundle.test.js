'use strict';
/**
 * browser/openvibe-sdk.mjs: up to date with the sources, self-contained (no import or require of
 * anything), free of server-only code, the same exports as the browser entry, and working.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { run } = require('./helpers');
const { OUT, collect } = require('../scripts/browser-bundle');
const { createMockPlatform } = require('../src/testing');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(OUT).href);

run([
    ['browser/openvibe-sdk.mjs is up to date', async () => {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts/browser-bundle.js'), '--check'], { stdio: 'pipe' });
    }],

    ['it is one self-contained module with no server-only code', async () => {
        const src = fs.readFileSync(OUT, 'utf8');
        assert.ok(!/\brequire\s*\(/.test(src), 'no require() left');
        assert.ok(!/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(src), 'imports nothing');
        for (const [re, why] of [[/client_secret/, 'client_secret'], [/process\.env/, 'process.env'], [/['"]node:/, 'node: module'], [/function (?:createServiceTokenClient|verifyUserToken|verifyAppToken|exchangeCode|createEventsClient|createIdentityClient|createMockPlatform)\b/, 'server-only API']]) {
            assert.ok(!re.test(src), `bundle contains ${why}`);
        }
        const ids = collect().map((m) => m.id);
        for (const never of ['src/auth/tokens.js', 'src/auth/jwt.js', 'src/auth/oauth.js', 'src/events.js', 'src/outbox.js', 'src/identity.js', 'src/testing/index.js']) assert.ok(!ids.includes(never), never);
        for (const must of ['browser.js', 'src/core/client.js', 'src/auth/browser.js', 'src/jobs.js', 'src/tools.js', 'src/projects.js', 'src/realtime.js']) assert.ok(ids.includes(must), must);
    }],

    ['exports match the browser entry', async () => {
        const esm = await load();
        const cjs = require('../browser.js');
        assert.deepEqual(Object.keys(esm).filter((k) => k !== 'default').sort(), Object.keys(cjs).sort());
        assert.deepEqual(Object.keys(esm.default).sort(), Object.keys(cjs).sort());
        for (const ns of ['auth', 'registry', 'modules', 'realtime', 'media', 'community', 'jobs', 'tools', 'projects']) {
            assert.deepEqual(Object.keys(esm[ns]).sort(), Object.keys(cjs[ns]).sort(), ns);
        }
        assert.notEqual(esm.createClient, cjs.createClient, 'its own copy, not the CommonJS modules');
        assert.equal(esm.SDK_VERSION, require('../package.json').version);
    }],

    ['it works: PKCE, an app sign-in URL, and a registry read through its own client', async () => {
        const sdk = await load();
        assert.equal(await sdk.auth.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
        const { url } = await sdk.auth.startAuthorization({ clientId: 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR', redirectUri: 'http://localhost:3001/callback', audience: 'openvibe.media', scope: ['media.object.read'] });
        const u = new URL(url);
        assert.equal(u.searchParams.get('audience'), 'openvibe.media');
        assert.equal(u.searchParams.get('scope'), 'media.object.read');
        const platform = createMockPlatform();
        const registry = sdk.registry.createRegistryClient(sdk.createClient({ fetch: platform.fetch }));
        assert.equal((await registry.domain('openvibe.media')).service.id, 'media');
        const err = new sdk.OpenVibeError({ code: 'x.y' });
        assert.ok(sdk.isOpenVibeError(err));
    }],
]);
