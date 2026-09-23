'use strict';
/**
 * No secrets or Node-only code in anything a browser bundle can reach. Resolves every export the
 * way a bundler does with the `browser` condition, follows relative require/import edges, and
 * fails on client_secret, node: imports, require('crypto'), process.env, or any non-relative
 * dependency. Exports that are server-only are declared with `"browser": null`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const CONDITIONS = ['browser', 'import', 'default'];

const FORBIDDEN = [
    [/client_secret/, 'mentions client_secret'],
    [/(?:require\s*\(|from\s+|import\s*\()\s*['"]node:/, 'imports a node: module'],
    [/require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/, "require('crypto')"],
    [/process\.env/, 'reads process.env'],
];

/** The target a browser bundler picks, or null when the export is blocked for browsers. */
function browserTarget(entry) {
    if (typeof entry === 'string') return entry;
    for (const c of CONDITIONS) if (Object.prototype.hasOwnProperty.call(entry, c)) return entry[c];
    return null;
}

function edges(src) {
    const out = [];
    const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
    return out;
}

function resolveLocal(from, spec) {
    const base = path.resolve(path.dirname(from), spec);
    for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    throw new Error(`${path.relative(ROOT, from)}: cannot resolve ${spec}`);
}

function closure(entryFile) {
    const seen = new Set();
    const stack = [entryFile];
    while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const spec of edges(fs.readFileSync(f, 'utf8'))) {
            if (!spec.startsWith('.')) throw new Error(`${path.relative(ROOT, f)} depends on "${spec}": browser code may only require its own relative files`);
            stack.push(resolveLocal(f, spec));
        }
    }
    return [...seen];
}

run([
    ['every browser-reachable file is free of secrets and Node-only code', async () => {
        const scanned = new Set();
        const blocked = [];
        for (const [sub, entry] of Object.entries(pkg.exports)) {
            if (sub === './package.json') continue;
            const target = browserTarget(entry);
            if (target === null) { blocked.push(sub); continue; }
            for (const file of closure(path.join(ROOT, target))) scanned.add(file);
        }
        for (const file of [path.join(ROOT, pkg.browser)]) for (const f of closure(file)) scanned.add(f);
        const problems = [];
        for (const file of scanned) {
            const src = fs.readFileSync(file, 'utf8');
            for (const [re, why] of FORBIDDEN) if (re.test(src)) problems.push(`${path.relative(ROOT, file)}: ${why}`);
        }
        assert.deepEqual(problems, []);
        assert.deepEqual(blocked.sort(), ['./events', './identity', './testing']);
        const rel = [...scanned].map((f) => path.relative(ROOT, f));
        for (const must of ['browser.js', 'src/core/client.js', 'src/auth/browser.js', 'src/realtime.js', 'src/media.js', 'src/community.js', 'src/modules.js', 'src/registry.js', 'src/jobs.js', 'src/projects.js', 'browser/openvibe-sdk.mjs']) {
            assert.ok(rel.includes(must), `${must} is scanned`);
        }
        for (const never of ['src/auth/tokens.js', 'src/auth/jwt.js', 'src/auth/oauth.js', 'src/events.js', 'src/identity.js', 'src/testing/index.js']) {
            assert.ok(!rel.includes(never), `${never} is not reachable from a browser entry`);
        }
        console.log(`    scanned ${scanned.size} files`);
    }],

    ['the scanner catches what it should', async () => {
        const bad = "const crypto = require('crypto');\nconst k = process.env.KEY;\nimport x from 'node:fs';\nbody.client_secret = s;";
        const hits = FORBIDDEN.filter(([re]) => re.test(bad)).map(([, why]) => why);
        assert.equal(hits.length, 4);
        assert.throws(() => closure(path.join(ROOT, 'src/events.js')), /may only require its own relative files|depends on "node:crypto"/);
    }],

    ['server entries really are server-only (sanity)', async () => {
        assert.match(fs.readFileSync(path.join(ROOT, 'src/auth/tokens.js'), 'utf8'), /client_secret/);
        assert.equal(browserTarget(pkg.exports['./auth']), './src/auth/browser.js');
    }],
]);
