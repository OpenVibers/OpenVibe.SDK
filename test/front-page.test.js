'use strict';
// openvibe-sdk/front-page: what may lead a front page. Slur cases are built at run time from OpenVibe.Chat's existing
// categories (defensive moderation: no term is written out here).
const assert = require('assert');
const { frontPageOk, containsCoreSlur } = require('../src/front-page');
const esm = import('../esm/front-page.mjs');

const blockedAlpha = ['k', 'y', 'k', 'e'].join('');        // an existing built-in pattern
const blockedBeta = ['f', 'a', 'g'].join('');              // another (the Community paste title of 2026-10-24)

for (const t of [`Some ${blockedBeta} from r.s.`, `you ${blockedAlpha}`, blockedAlpha.split('').join(' '), blockedAlpha.split('').join('.'),
    blockedAlpha.replace('e', '3'), blockedAlpha.toUpperCase()]) {
    assert.ok(containsCoreSlur(t), `slur: ${t.length} chars`);
    assert.ok(!frontPageOk(t), 'a slur never leads');
}
for (const t of ['this is fucking great', 'bullshit take', 'tô com o rollback do caralho', 'qué mierda', 'putain de lag', 'so ein Scheiße', 'an anti-semitic trope']) {
    assert.ok(!frontPageOk(t), `rough: ${t}`);
}
for (const t of ['Faggin Pizza Party', 'a spicy taco', 'Fagaras mountains', 'shitake', 'Scunthorpe United', 'the classic Puttana sauce',
    'A creator explains the project', 'Lately on OpenVibe', 'gg', '😂']) {
    assert.ok(frontPageOk(t), `ok: ${t}`);
}
assert.ok(!frontPageOk('') && !frontPageOk('   ') && !frontPageOk(null), 'nothing to show');

esm.then((m) => {
    assert.strictEqual(m.frontPageOk, frontPageOk);
    assert.strictEqual(m.containsCoreSlur, containsCoreSlur);
    console.log('front-page: slurs, rough words in five languages, near misses and the ESM entry pass');
}).catch((e) => { console.error(e); process.exit(1); });
