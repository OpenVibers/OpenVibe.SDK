'use strict';
/**
 * openvibe-sdk/redact: the shared corpus of secret shapes (Memory M2). It is the same file OpenVibe.Node copies into
 * its internal/memory/testdata, so the Node's Go scrubber and this port cannot drift: every case says what must be
 * gone and what must stay.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { redact, onlySecret } = require('../src/redact');
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'redact-corpus.json'), 'utf8'));

run([
    ['the corpus has every case and a stable shape', async () => {
        assert.ok(Array.isArray(corpus.cases) && corpus.cases.length >= 50, `the corpus has ${corpus.cases.length} cases`);
        for (const c of corpus.cases) {
            assert.equal(typeof c.name, 'string', 'every case is named');
            assert.equal(typeof c.in, 'string', `${c.name}: in`);
            assert.ok(Array.isArray(c.mustNotContain), `${c.name}: mustNotContain`);
            assert.ok(Array.isArray(c.mustContain), `${c.name}: mustContain`);
        }
    }],

    ['every case: the secrets go, the words around them stay, and the count is right', async () => {
        for (const c of corpus.cases) {
            const out = redact(c.in);
            for (const secret of c.mustNotContain) {
                assert.ok(!out.text.includes(secret), `${c.name}: ${secret} is still there: ${out.text}`);
            }
            for (const keep of c.mustContain) {
                assert.ok(out.text.includes(keep), `${c.name}: the text lost ${keep}: ${out.text}`);
            }
            if (c.mustNotContain.length === 0) {
                assert.equal(out.count, 0, `${c.name}: harmless text was counted as a secret`);
                assert.equal(out.text, c.in, `${c.name}: harmless text was changed`);
            } else {
                assert.ok(out.count > 0, `${c.name}: nothing was counted as redacted`);
                assert.ok(out.text.includes('[redacted]'), `${c.name}: no marker in ${out.text}`);
            }
        }
    }],

    ['a second pass changes nothing and counts nothing', async () => {
        for (const c of corpus.cases) {
            const once = redact(c.in);
            const twice = redact(once.text);
            assert.equal(twice.text, once.text, `${c.name}: the second pass changed the text`);
            assert.equal(twice.count, 0, `${c.name}: the second pass counted ${twice.count}`);
        }
    }],

    ['onlySecret: an item that was nothing but a secret is refused, a note is not', async () => {
        assert.equal(onlySecret('[redacted]'), true);
        assert.equal(onlySecret('  [redacted]\n[redacted]  '), true);
        assert.equal(onlySecret(''), true);
        assert.equal(onlySecret(redact('sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8').text), true);
        assert.equal(onlySecret('a note about [redacted]'), false);
        assert.equal(onlySecret('a note'), false);
    }],
]);
