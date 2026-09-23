'use strict';
/** ESM entry points match the CommonJS modules; the package resolves by name (self-reference). */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { run } = require('./helpers');
const { ENTRIES } = require('../scripts/esm');

const ROOT = path.join(__dirname, '..');

run([
    ['esm/*.mjs are up to date', async () => {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts/esm.js'), '--check'], { stdio: 'pipe' });
    }],

    ['every ESM file exports exactly the CommonJS names', async () => {
        for (const [file, target] of Object.entries(ENTRIES)) {
            const cjs = require(path.join(ROOT, 'esm', target));
            const esm = await import(pathToFileURL(path.join(ROOT, 'esm', file)).href);
            const names = Object.keys(esm).filter((k) => k !== 'default').sort();
            assert.deepEqual(names, Object.keys(cjs).sort(), file);
            assert.equal(esm.default, cjs);
        }
    }],

    ['every subpath resolves by package name for require and import', async () => {
        const pkg = require('../package.json');
        for (const sub of Object.keys(pkg.exports)) {
            if (sub === './package.json') continue;
            const spec = sub === '.' ? 'openvibe-sdk' : `openvibe-sdk/${sub.slice(2)}`;
            const cjs = require(spec);
            const esm = await import(spec);
            assert.ok(Object.keys(cjs).length > 0, spec);
            assert.equal(esm.default, cjs, `${spec}: import and require share one module instance`);
        }
        const { createClient } = await import('openvibe-sdk/core');
        assert.equal(typeof createClient, 'function');
    }],
]);
