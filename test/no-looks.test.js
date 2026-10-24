'use strict';
// openvibe-sdk/no-looks: the shared corpus. Every case here was public AI text on OpenVibe.Live or Community (frame
// notes, overviews, clip lines, paste picture descriptions) or a near miss that must stay as written.
const assert = require('assert');
const { noLooks, noLooksTags, hasLooks, RULES_VERSION } = require('../src/no-looks');
const esm = import('../esm/no-looks.mjs');

const cases = [
    ['A shirtless man sits in a room with framed pictures on the wall.', 'The streamer sits in a room with framed pictures on the wall.'],
    // 2026-10-24: the AI moments job titled clip 483 "A Naked Man Lying On Their Back With Legs" on Live's home.
    ['A naked man lies on his back on a bed.', 'The streamer lies on their back on a bed.'],
    ['The streamer, half-naked, waves at chat.', 'The streamer waves at chat.'],
    ['A livestream frame showing a shirtless streamer in a small inset while playing a MOBA.', 'A livestream frame showing the streamer in a small inset while playing a MOBA.'],
    ['Chat watches a young boy at a desk build a PC.', 'Chat watches the streamer at a desk build a PC.'],
    ['Young, bearded man plays chess.', 'Streamer plays chess.'],
    ['A man plays chess next to a black chair.', 'A person plays chess next to a black chair.'],
    ['The streamer, topless, laughs at chat.', 'The streamer laughs at chat.'],
    ['A man is shirtless and appears to be talking to chat.', 'A person appears to be talking to chat.'],
    ['A person watches TV while a child sits nearby.', 'A person watches TV while someone sits nearby.'],
    ['The girl waves at the camera.', 'The person waves at the camera.'],
    // Clothing, hair and face go; the rest of the sentence stays.
    ['The streamer wearing a red beanie speaks to the camera outdoors, seemingly addressing chat.', 'The streamer speaks to the camera outdoors, seemingly addressing chat.'],
    ['The view is close to the camera while wearing a black beanie and hoodie, with trees around.', 'The view is close to the camera, with trees around.'],
    ['A man in a gray tank top sits against a plain light background.', 'A person sits against a plain light background.'],
    ['A man with a long beard and plaid shirt examines a woven item.', 'A person examines a woven item.'],
    // Pose and expression are the person too (2026-10-17, the home page's "Right now").
    ['A live stream frame shows the streamer in a small window bottom-left, appearing to be reacting with a thoughtful pose while the main screen is black.',
        'A live stream frame shows the streamer in a small window bottom-left while the main screen is black.'],
    ['The streamer sits in a relaxed posture at the desk.', 'The streamer sits at the desk.'],
    ['A kitchen studio with a headset-wearing host, microphone, and on-screen graphics.', 'A kitchen studio with a host, microphone, and on-screen graphics.'],
    ['Panelists discuss while wearing headsets and microphones, with a trophy nearby.', 'Panelists discuss, with a trophy nearby.'],
    ['A man wearing sunglasses on his head looks down at the camera.', 'A person looks down at the camera.'],
    ['A collage of a man in a white shirt and tie wearing dark sunglasses in the left panel.', 'A collage of a person in the left panel.'],
    ['Behind him a green mat; he wears a blue jacket and is leaning to the left.', 'Behind them a green mat; the person is leaning to the left.'],
    ['Two men lift weights, one shirtless and sweating.', 'Two people lift weights, one sweating.'],
    ['Two men stand in an alley, one and drinking from a bottle while the other wears a dusty t-shirt; both look tired.', 'Two people stand in an alley, one drinking from a bottle; both look tired.'],
    ['A man wearing a green bucket hat with frog-like eyes sits indoors.', 'A person sits indoors.'],
    ['A man in sunglasses reaches toward the camera inside a car.', 'A person reaches toward the camera inside a car.'],
    ['A live stream window shows a broadcaster with a headset on the left, a chat panel on the right.', 'A live stream window shows a broadcaster on the left, a chat panel on the right.'],
    ['A man with a red shirt sits in a room; a desk with a headset and keyboard.', 'A person sits in a room; a desk with a headset and keyboard.'],
    ['A gamer faces a casually dressed NPC in a grim interior.', 'A gamer faces a NPC in a grim interior.'],
    ['A cartoon streaming setup: wearing a headset with a microphone, rugged jacket, backpack with a mat.', 'A cartoon streaming setup: backpack with a mat.'],
    ['A partial view of a person wearing a gray zip-up jacket with a white zipper, seated indoors.', 'A partial view of a person, seated indoors.'],
    ['Close-up of a person wearing a yellow vest over a gray knit top, with a backpack visible.', 'Close-up of a person, with a backpack visible.'],
    ['A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.', 'A Minecraft player in a top-down view builds a house; the streamer reviews new headphones.'],
    ['The streamer laughs — heard: "Put your headset on. I like your hair."', 'The streamer laughs — heard: "Put your headset on. I like your hair."'],
    // Clip overviews found public on 2026-10-22: a guessed gender, a slashed pattern before a shirt, a grooming sentence.
    ['The video features a man in a plaid/checkered shirt delivering a live-streamed explanation or discussion.', 'The video features a person delivering a live-streamed explanation or discussion.'],
    ['The video shows a man in a kitchen setting, appearing to stream live from a couch or kitchen area.', 'The video shows a person in a kitchen setting, appearing to stream live from a couch or kitchen area.'],
    ['The video centers on a live stream featuring a male or female host wearing headphones, visible in a small webcam window.', 'The video centers on a live stream featuring a host, visible in a small webcam window.'],
    ['A home kitchen where a person adjusts their hair or clothing near the counter. A pot of soup simmers on the stove.', 'A pot of soup simmers on the stove.'],
    ['A female streamer and two guys race karts; the other men cheer.', 'A streamer and two people race karts; the other people cheer.'],
    ['An Iron Man skin fights Pac-Man in a man-made arena while chat says "that man is cracked".', 'An Iron Man skin fights Pac-Man in a man-made arena while chat says "that man is cracked".'],
    // The face, body and clothes the word lists do not name (production card lines after #299): the sentence goes.
    ['A person in outdoor gear with a helmet and face shield is looking off to the side. A second person leans into the frame from the left.', 'A second person leans into the frame from the left.'],
    ['The video features close-up shots of the streamer smiling broadly, displaying white teeth and a beard. The chat cheers.', 'The chat cheers.'],
    ['The streamer packs camera gear into a bag.', 'The streamer packs camera gear into a bag.'],
    ['A second person leans into the frame from the left, with a blue jacket partially visible.', 'A second person leans into the frame from the left.'],
    ['A cozy desk, with a headset and a mug, faces the window.', 'A cozy desk, with a headset and a mug, faces the window.'],
    ['The streamer, who is tired, is quiet tonight.', 'The streamer, who is tired, is quiet tonight.'],
    ['A third person, with a blue jacket partially visible, is shown in a close-up, looking to the left and wearing an earbud.', 'A third person is shown in a close-up, looking to the left.'],
];

// Paste picture descriptions found public on Community (2026-10-22).
cases.push(
    ['A man lounging on a sofa in a living room, holding a remote and facing camera.', 'A person lounging on a sofa in a living room, holding a remote and facing camera.'],
    ['A man is shown outdoors, smoking a cigarette against a clear blue sky.', 'A person is shown outdoors, smoking a cigarette against a clear blue sky.'],
    ['A man sitting on a bed reading a book while homework papers and stacked boxes surround him.', 'A person sitting on a bed reading a book while homework papers and stacked boxes surround them.'],
);

// Pronouns are a guessed gender too (27 repaired Community summaries kept "he looks", "on his device"): he and she are
// "the person", his and her "their", him and her "them"; quoted speech stays.
cases.push(
    ['He looks at the camera and adjusts the volume on his device.', 'The person looks at the camera and adjusts the volume on their device.'],
    ['The streamer checks his phone and laughs at her joke.', 'The streamer checks their phone and laughs at their joke.'],
    ['Chat cheers for her.', 'Chat cheers for them.'],
    ['The streamer gives her a wave and thanks him for the raid.', 'The streamer gives them a wave and thanks them for the raid.'],
    ["She's playing Minecraft with him; he'll join later.", "The person's playing Minecraft with them; the person will join later."],
    ['He hurt himself, but the win is his.', 'The person hurt themself, but the win is theirs.'],
    ['A person reads, says "he is lying to her", and waves at her chat.', 'A person reads, says "he is lying to her", and waves at their chat.'],
    ['Shell, Heather and the theme park stay as written.', 'Shell, Heather and the theme park stay as written.'],
);

let failed = 0;
for (const [input, want] of cases) {
    const got = noLooks(input);
    if (got !== want) { failed++; console.error(`✗ ${JSON.stringify(input)}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}
assert.strictEqual(failed, 0, `${failed} of ${cases.length} cases`);

// Not text: returned as given.
assert.strictEqual(noLooks(null), null);
assert.strictEqual(noLooks(''), '');
assert.strictEqual(noLooks(undefined), undefined);

// Tags: clothing, hair, face, age and gendered people go.
assert.deepStrictEqual(noLooksTags(['red-beanie', 'bearded', 'man', 'tanktop', 'hula hoop', 'laptop', 'minecraft', 'outdoors', 'jacket', 'selfie']), ['hula hoop', 'laptop', 'minecraft', 'outdoors']);
assert.deepStrictEqual(noLooksTags('man'), []);
assert.deepStrictEqual(noLooksTags([1, '', ' ', 'sofa']), ['sofa']);

// Titles: one that names looks is replaced, not repaired.
assert.strictEqual(hasLooks('Orange Shirt Kitchen Chat'), true);
assert.strictEqual(hasLooks('Minecraft Castle Marathon'), false);
assert.strictEqual(hasLooks('A Naked Man Lying On Their Back With Legs'), true);
assert.strictEqual(hasLooks('Noteworthy Half-Naked Moment'), true, 'no person word: the nudity word alone');
assert.strictEqual(hasLooks('Nude Beach Debate'), true);
assert.strictEqual(hasLooks(null), false);

// The rules' version: 16 hex digits, stable for these rules.
assert.match(RULES_VERSION, /^[0-9a-f]{16}$/);

esm.then((m) => {
    assert.strictEqual(m.noLooks, noLooks);
    assert.strictEqual(m.RULES_VERSION, RULES_VERSION);
    console.log(`no-looks: ${cases.length} cases, tags, titles and the ESM entry pass (rules ${RULES_VERSION})`);
}).catch((e) => { console.error(e); process.exit(1); });
