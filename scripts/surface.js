#!/usr/bin/env node
'use strict';
/**
 * The public surface: every name each package entry exports, and what it is, in docs/api-surface.json. About 40
 * services pin this package, so a name that disappears or changes kind breaks them on their next pin round; the file
 * makes every such change a reviewed line in a diff, and test/surface.test.js fails when the exports and the file
 * disagree.
 *
 *   node scripts/surface.js           write docs/api-surface.json from the exports
 *   node scripts/surface.js --check   exit 1, listing what changed, when they disagree
 *
 * For each entry (`openvibe-sdk`, `openvibe-sdk/core`, …): name → "function" | "class" | "array" | "string" |
 * "number" | "boolean" | "null", { "object": [its keys] } for a plain object (constants, error codes), one level
 * deep, or "lazy" for a getter that loads an optional peer package (`openvibe-sdk/service`'s openvibe-shared parts):
 * it is never called here. A name removed, a kind changed or an object key removed is breaking; anything new is an
 * addition.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs', 'api-surface.json');
// What the 1.0 freeze covers first (README, "Versioning"): a change there is marked on its own.
const CORE = ['openvibe-sdk/core', 'openvibe-sdk/auth', 'openvibe-sdk/events', 'openvibe-sdk/db', 'openvibe-sdk/media'];
// Inside those entries, each name's tier (docs/one-point-oh.md): frozen in 1.0, platform (exported, not frozen) or
// leaving before 1.0. test/surface.test.js fails when a name there has no tier.
const TIERS_FILE = path.join(ROOT, 'docs', 'one-point-oh.json');
const TIERS = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8'));

function kindOf(v) {
    if (typeof v === 'function') return /^class[\s{]/.test(Function.prototype.toString.call(v)) ? 'class' : 'function';
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** One module's exports as the file records them. */
function describe(mod) {
    const out = {};
    for (const name of Object.keys(mod).sort()) {
        const d = Object.getOwnPropertyDescriptor(mod, name);
        if (d && d.get) { out[name] = 'lazy'; continue; }
        const v = mod[name];
        out[name] = isPlainObject(v) ? { object: Object.keys(v).sort() } : kindOf(v);
    }
    return out;
}

/** Every entry in package.json "exports" (the browser bundle and package.json itself aside), by its import name. */
function current() {
    const pkg = require(path.join(ROOT, 'package.json'));
    const surface = {};
    for (const sub of Object.keys(pkg.exports).sort()) {
        if (sub === './package.json' || sub.endsWith('.mjs')) continue;
        const spec = sub === '.' ? 'openvibe-sdk' : `openvibe-sdk/${sub.slice(2)}`;
        surface[spec] = describe(require(spec));
    }
    return surface;
}

const kindName = (k) => (typeof k === 'string' ? k : 'object');

/** → { breaking: [...], added: [...] } between two surfaces. */
function diff(before, after) {
    const breaking = [];
    const added = [];
    const tag = (spec, name) => {
        if (!CORE.includes(spec)) return '';
        const t = (name && TIERS[spec]) || {};
        if ((t.platform || []).includes(name)) return ' [1.0 core entry, platform tier]';
        if ((t.leaving || []).includes(name)) return ' [1.0 core entry, leaves before 1.0]';
        return ' [1.0 core]';
    };
    for (const spec of Object.keys(before)) {
        if (!(spec in after)) { breaking.push(`${spec}: the entry is gone${tag(spec)}`); continue; }
        const was = before[spec];
        const now = after[spec];
        for (const name of Object.keys(was)) {
            const a = was[name];
            const b = now[name];
            if (b === undefined) breaking.push(`${spec}: ${name} is gone${tag(spec, name)}`);
            else if (a !== 'lazy' && b !== 'lazy' && kindName(a) !== kindName(b)) breaking.push(`${spec}: ${name} was a ${kindName(a)}, now a ${kindName(b)}${tag(spec, name)}`);
            else if (typeof a !== 'string') {
                for (const k of a.object) if (!b.object.includes(k)) breaking.push(`${spec}: ${name}.${k} is gone${tag(spec, name)}`);
                for (const k of b.object) if (!a.object.includes(k)) added.push(`${spec}: ${name}.${k}`);
            }
        }
        for (const name of Object.keys(now)) if (!(name in was)) added.push(`${spec}: ${name}`);
    }
    for (const spec of Object.keys(after)) if (!(spec in before)) added.push(`${spec} (a new entry)`);
    return { breaking, added };
}

function render(surface) {
    return `${JSON.stringify(surface, null, 2)}\n`;
}

function main(argv = process.argv.slice(2)) {
    const now = current();
    if (!argv.includes('--check')) {
        fs.writeFileSync(FILE, render(now));
        console.log(`wrote ${path.relative(ROOT, FILE)}: ${Object.keys(now).length} entries, ${Object.values(now).reduce((n, m) => n + Object.keys(m).length, 0)} names`);
        return 0;
    }
    const recorded = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
    const { breaking, added } = diff(recorded, now);
    if (!breaking.length && !added.length) return 0;
    if (breaking.length) console.error(`Breaking (say so in CHANGELOG.md; from 1.0 on it needs a major release):\n  ${breaking.join('\n  ')}`);
    if (added.length) console.error(`Added:\n  ${added.join('\n  ')}`);
    console.error('Then run `node scripts/surface.js` to update docs/api-surface.json.');
    return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { current, describe, diff, render, CORE, TIERS, FILE };
