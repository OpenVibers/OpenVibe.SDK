'use strict';
// openvibe-sdk/no-looks is deprecated (owner, 2026-10-31: AI text may describe people): its functions return what they
// are given. openvibe-sdk/explicit keeps the one rule that stays: AI text that says a scene shows sexual content is not
// published.
const assert = require('assert');
const { noLooks, noLooksTags, hasLooks, isExplicit, RULES_VERSION } = require('../src/no-looks');
const explicit = require('../src/explicit');

// Describing people is fine: the text, the tags and the titles come back as given.
for (const t of ['A shirtless man sits in a room with framed pictures on the wall.', 'She has a hat and glasses on.', 'Young, bearded man plays chess.', '', null, 42]) {
    assert.strictEqual(noLooks(t), t, `as given: ${t}`);
}
assert.deepStrictEqual(noLooksTags(['red-beanie', 'man', 'minecraft', 7]), ['red-beanie', 'man', 'minecraft'], 'string tags as given');
assert.deepStrictEqual(noLooksTags(null), []);
assert.strictEqual(hasLooks('A Shirtless DJ Spins'), false, 'a title that describes someone is fine');
assert.strictEqual(RULES_VERSION, 'off');

// isExplicit: what a scene shows (Live's clip 483 on 2026-10-23, word for word), from either module.
assert.strictEqual(isExplicit, explicit.isExplicit, 'one function, re-exported');
for (const t of [
    'A naked man lying on their back with legs spread, reaching toward their genitals',
    'The video shows the streamer engaging in explicit adult content, with close-up footage of sexual acts on a couch',
    'Pornographic footage plays on the second monitor', 'The scene contains nudity', 'masturbating on camera',
]) assert.ok(isExplicit(t), `explicit: ${t}`);
for (const t of ['A player in Fortnite is sprinting along a pink-purple sunset map', 'They read the news from Essex', 'A sextant and a map', 'A shirtless man sits', '', null, undefined]) {
    assert.ok(!isExplicit(t), `not explicit: ${t}`);
}
assert.ok(isExplicit('a fine title', null, 'the frame shows sexual activity'), 'any of several texts');

Promise.all([import('../esm/no-looks.mjs'), import('../esm/explicit.mjs')]).then(([m, e]) => {
    assert.strictEqual(m.noLooks, noLooks);
    assert.strictEqual(m.isExplicit, isExplicit);
    assert.strictEqual(e.isExplicit, isExplicit);
    console.log('no-looks: deprecated, returns what it is given; explicit: the publishing gate holds (CJS and ESM)');
}).catch((e) => { console.error(e); process.exit(1); });
