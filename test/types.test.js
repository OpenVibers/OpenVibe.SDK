'use strict';
/**
 * Type declarations stay honest: every runtime export of a subpath is declared in its .d.ts, and
 * the contract types copied from openvibe-contracts match a Contracts checkout when one is next
 * to this repository (skipped otherwise).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { run } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

function declared(dtsFile, seen = new Set()) {
    if (seen.has(dtsFile)) return new Set();
    seen.add(dtsFile);
    const src = fs.readFileSync(dtsFile, 'utf8');
    const names = new Set();
    const re = /export\s+(?:declare\s+)?(?:function|const|class|interface|type|let)\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
    const ns = /export\s+\*\s+as\s+(\w+)\s+from/g;
    while ((m = ns.exec(src))) names.add(m[1]);
    const star = /export\s+\*\s+from\s+'(\.\/[^']+)'/g;
    while ((m = star.exec(src))) for (const n of declared(path.join(path.dirname(dtsFile), `${m[1]}.d.ts`), seen)) names.add(n);
    return names;
}

run([
    ['every runtime export has a declaration', async () => {
        const missing = [];
        for (const [sub, entry] of Object.entries(pkg.exports)) {
            if (sub === './package.json') continue;
            const names = declared(path.join(ROOT, entry.types));
            const runtime = entry.default.endsWith('.mjs')
                ? Object.keys(await import(pathToFileURL(path.join(ROOT, entry.default)).href)).filter((k) => k !== 'default')
                : Object.keys(require(path.join(ROOT, entry.default)));
            for (const n of runtime) if (!names.has(n)) missing.push(`${sub}: ${n}`);
            const browser = entry.browser ? Object.keys(require(path.join(ROOT, entry.browser))) : [];
            for (const n of browser) if (!names.has(n)) missing.push(`${sub} (browser): ${n}`);
        }
        assert.deepEqual(missing, []);
    }],

    ['copied contract types match openvibe-contracts', async () => {
        const candidates = [
            path.join(ROOT, 'node_modules/openvibe-contracts/generated/typescript/index.d.ts'),
            path.join(ROOT, '../OpenVibe.Contracts/generated/typescript/index.d.ts'),
        ];
        const source = candidates.find((p) => fs.existsSync(p));
        if (!source) { console.log('    skipped: no openvibe-contracts checkout next to this repository'); return; }
        const theirs = fs.readFileSync(source, 'utf8');
        const ours = fs.readFileSync(path.join(ROOT, 'types/contracts.d.ts'), 'utf8');
        const blocks = ours.split(/\n(?=\/\*\* [a-z]+\.[a-z-]+@)/).slice(1).map((b) => b.trim());
        assert.ok(blocks.length >= 9);
        for (const b of blocks) {
            const id = b.match(/^\/\*\* ([a-z]+\.[a-z-]+)@/)[1];
            const at = theirs.indexOf(`/** ${id}@`);
            assert.ok(at >= 0, `${id} exists in Contracts`);
            assert.ok(theirs.includes(b), `${id} is identical to Contracts (re-copy types/contracts.d.ts after a Contracts release)`);
        }
    }],
]);
