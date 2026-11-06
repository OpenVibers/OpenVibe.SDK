'use strict';
/**
 * The 256 words of a fingerprint. A fingerprint is the first four bytes of SHA-256 over a
 * person's two public keys, read as four words: eight bits each, so the words say which of the
 * 256 they are. It is short enough to read out loud and compare once, which is the whole point:
 * a person checks that the four words on the screen are the four words the other person sees.
 *
 * The order is part of the format: word number n is the nth word here. Changing the list would
 * change every fingerprint, so it is frozen with the version.
 */
const WORDS = [
    'amber', 'anchor', 'apple', 'arrow', 'aspen', 'autumn', 'badge', 'bamboo',
    'beacon', 'berry', 'birch', 'bison', 'blossom', 'breeze', 'brick', 'brook',
    'bucket', 'bugle', 'cabin', 'cactus', 'candle', 'canoe', 'canyon', 'cedar',
    'cellar', 'chalk', 'cherry', 'cider', 'cinder', 'citrus', 'clay', 'clover',
    'cobalt', 'cocoa', 'comet', 'coral', 'cosmos', 'cotton', 'cove', 'crane',
    'crater', 'crayon', 'cricket', 'crimson', 'crystal', 'cymbal', 'daisy', 'dapple',
    'dawn', 'delta', 'desert', 'diamond', 'dolphin', 'domino', 'donkey', 'dragon',
    'drift', 'drizzle', 'drum', 'dune', 'dusk', 'eagle', 'ember', 'emerald',
    'estuary', 'fable', 'falcon', 'feather', 'fern', 'ferry', 'field', 'flame',
    'flint', 'forest', 'fossil', 'fox', 'frost', 'galaxy', 'garden', 'garnet',
    'gazelle', 'geyser', 'ginger', 'glacier', 'granite', 'grape', 'gravel', 'grove',
    'guitar', 'haiku', 'harbor', 'hazel', 'heather', 'hollow', 'honey', 'horizon',
    'ice', 'indigo', 'island', 'ivory', 'jasper', 'jungle', 'juniper', 'kayak',
    'kernel', 'kestrel', 'lagoon', 'lantern', 'lattice', 'laurel', 'lemon', 'lichen',
    'lilac', 'linen', 'lotus', 'lunar', 'magnet', 'mango', 'maple', 'marble',
    'marsh', 'meadow', 'meteor', 'mint', 'mirror', 'mist', 'monsoon', 'moss',
    'moth', 'mountain', 'nectar', 'needle', 'nest', 'nettle', 'night', 'oasis',
    'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchard', 'orchid', 'osprey',
    'otter', 'owl', 'oyster', 'palace', 'palm', 'panda', 'papaya', 'paper',
    'peach', 'pearl', 'pebble', 'pecan', 'penguin', 'peony', 'pepper', 'petal',
    'pine', 'plateau', 'plum', 'pollen', 'pond', 'poplar', 'poppy', 'prairie',
    'prism', 'pumpkin', 'quail', 'quarry', 'quartz', 'rabbit', 'radish', 'rain',
    'raven', 'reef', 'ridge', 'river', 'robin', 'rosemary', 'sage', 'salmon',
    'sand', 'sapphire', 'satellite', 'scallop', 'shadow', 'shell', 'shore', 'shuttle',
    'silk', 'silver', 'slate', 'snow', 'solar', 'sparrow', 'spruce', 'star',
    'stone', 'storm', 'stream', 'sugar', 'summit', 'sunset', 'swan', 'thistle',
    'thunder', 'tide', 'tiger', 'timber', 'topaz', 'trail', 'tulip', 'tundra',
    'turtle', 'valley', 'vapor', 'velvet', 'vine', 'violet', 'walnut', 'wave',
    'whale', 'wheat', 'willow', 'winter', 'wolf', 'wren', 'yacht', 'yarrow',
    'yew', 'zinc', 'zephyr', 'almond', 'basil', 'cinnamon', 'cypress', 'damson',
    'elder', 'fennel', 'garlic', 'hibiscus', 'iris', 'jasmine', 'linden', 'melon',
    'nutmeg', 'sesame', 'sorrel', 'thyme', 'anise', 'chicory', 'dill', 'endive',
];

module.exports = { WORDS };
