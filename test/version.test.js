'use strict';
/** SDK_VERSION, package.json, the lockfile, the CHANGELOG and the bundle agree. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

run([
    ['core.SDK_VERSION is the package version', async () => {
        assert.equal(require('../src/core').SDK_VERSION, pkg.version);
        assert.equal(require('..').SDK_VERSION, pkg.version);
        assert.equal(require('../browser.js').SDK_VERSION, pkg.version);
    }],

    ['the lockfile, the CHANGELOG and the bundle name the same version', async () => {
        const lock = require('../package-lock.json');
        assert.equal(lock.version, pkg.version);
        assert.equal(lock.packages[''].version, pkg.version);
        assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} \\(`, 'm'));
        assert.match(fs.readFileSync(path.join(ROOT, 'browser/openvibe-sdk.mjs'), 'utf8'), new RegExp(`openvibe-sdk ${pkg.version.replace(/\./g, '\\.')},`));
    }],

    ['the README installs and names this release (it said v0.35.2 and v0.37.0 at 0.51.1)', async () => {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        assert.ok(readme.includes(`npm install https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v${pkg.version}\n`), 'the install line');
        assert.ok(readme.includes(`**Status:** alpha, v${pkg.version} (`), 'the status line');
    }],
]);
