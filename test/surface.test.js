'use strict';
/**
 * docs/api-surface.json (scripts/surface.js) matches what every entry exports, so a name that disappears or changes
 * kind is a reviewed line in a diff, never a surprise on a service's next pin round; and the diff calls it breaking.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { run } = require('./helpers');
const { current, describe, diff, render, CORE, FILE } = require('../scripts/surface');

run([
    ['docs/api-surface.json lists every export (node scripts/surface.js updates it)', async () => {
        const recorded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const { breaking, added } = diff(recorded, current());
        assert.deepEqual({ breaking, added }, { breaking: [], added: [] }, 'run `node scripts/surface.js` and say what changed in CHANGELOG.md');
        assert.equal(fs.readFileSync(FILE, 'utf8'), render(current()), 'the file is exactly what the script writes');
    }],

    ['the 1.0 core entries are in it', async () => {
        const recorded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const spec of CORE) assert.ok(Object.keys(recorded[spec] || {}).length > 0, spec);
        assert.equal(recorded['openvibe-sdk/core'].createClient, 'function');
    }],

    ['what each kind of export records', async () => {
        class Thing {}
        const mod = { f() {}, Thing, list: [1], codes: { B: 1, A: 2 }, name: 'x', n: 1, on: true, none: null, map: new Map() };
        Object.defineProperty(mod, 'optional', { enumerable: true, get() { throw new Error('never read'); } });
        assert.deepEqual(describe(mod), {
            Thing: 'class', codes: { object: ['A', 'B'] }, f: 'function', list: 'array', map: 'object', n: 'number', name: 'string', none: 'null', on: 'boolean', optional: 'lazy',
        });
    }],

    ['a removal, a kind change or a removed key is breaking; anything new is an addition', async () => {
        const before = { 'openvibe-sdk/core': { a: 'function', b: 'function', c: { object: ['X', 'Y'] }, d: 'lazy' }, 'openvibe-sdk/old': { z: 'function' } };
        const after = { 'openvibe-sdk/core': { a: 'function', b: 'class', c: { object: ['X', 'Z'] }, d: 'function', e: 'function' }, 'openvibe-sdk/new': { y: 'function' } };
        assert.deepEqual(diff(before, after), {
            breaking: ['openvibe-sdk/core: b was a function, now a class [1.0 core]', 'openvibe-sdk/core: c.Y is gone [1.0 core]', 'openvibe-sdk/old: the entry is gone'],
            added: ['openvibe-sdk/core: c.Z', 'openvibe-sdk/core: e', 'openvibe-sdk/new (a new entry)'],
        });
        assert.deepEqual(diff(before, before), { breaking: [], added: [] });
    }],
]);
