'use strict';
/**
 * openvibe-sdk/no-looks: public AI text never describes a person (the owner's rule): no looks, body, clothing, hair,
 * face, pose, age or guessed gender. Prompts say so, but models ignore it about one time in ten, so AI text that is
 * stored or served publicly passes noLooks() (and noLooksTags() for tags), and a short AI title that names looks is
 * not used (hasLooks()). Moved from OpenVibe.Live (server/db/database.js, Live#298–#302) so every service that stores
 * public AI text runs the same rules against one test corpus (test/no-looks.test.js).
 *
 * - noLooks(text): "A shirtless man sits…" → "The streamer sits…"; "a man in a kitchen" → "a person in a kitchen";
 *   "two men" → "two people"; a clause about clothes, hair or a pose goes; a sentence about someone's hair, face,
 *   body or clothes that cannot be repaired word by word goes. Quoted speech ("I like your hair") stays word for word,
 *   and so do names (Iron Man, Pac-Man) and things a person holds or reviews (a headset on a desk).
 * - noLooksTags(tags): drops tags that name clothing, hair, face, age or a person by gender ("red-beanie", "man").
 * - hasLooks(text): true when a short text names looks at all; such a title is replaced rather than repaired.
 * - RULES_VERSION: a short hash of the rules. A service that repairs stored rows records it and runs the repair again
 *   when it changes.
 *
 * Pure functions, no dependencies: safe in Node and in browsers.
 */

const _LOOKS = 'shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed|young|younger|teenage|teen|little|bearded|bald|blonde?|(?:dark|long|short|curly|red|gr[ae]y|black|brown)-haired|tattooed|muscular|heavyset|older|elderly|middle-aged|skinny|slim|chubby|attractive|pretty|handsome|cute';
const _PEOPLE = 'man|woman|boy|girl|guy|gal|kid|child|teen|teenager|lady|gentleman|male|female|person|individual|streamer|youth';
const _AGE_NOUN = /^(?:boy|girl|kid|child|teen|teenager|youth)$/i;
const _LOOKED_AT = new RegExp(`\\b(a|an|the|one)\\s+((?:(?:${_LOOKS})[\\s,]+(?:and\\s+)?)*)(${_PEOPLE})\\b`, 'gi');
const _LOOKED_AT_BARE = new RegExp(`\\b(?:(?:${_LOOKS})[\\s,]+(?:and\\s+)?)+(${_PEOPLE})\\b`, 'gi');
const _cap = (m, s) => (/^[A-Z]/.test(m) ? s[0].toUpperCase() + s.slice(1) : s);
// What someone wears or how their hair and face look ("wearing a black beanie and hoodie", "in a red shirt",
// "with blond hair and a mustache", "a headset-wearing host") goes; the sentence keeps everything else. Quoted
// speech ("Heard: "I like your hair"") is what was said and stays word for word.
const _ART = '(?:(?:a|an|the|his|her|their|some|matching)\\s+)?';
const _WORN = 't-shirts?|shirts?|tees?|tank tops?|hoodies?|sweatshirts?|sweaters?|jackets?|coats?|vests?|beanies?|baseball caps?|caps?|hats?|helmets?|headsets?|headphones|sunglasses|glasses|outfits?|dress(?:es)?|jerseys?|suits?|robes?|bandanas?|scarf|scarves|masks?|apparel|attire';
const _FACE = 'beards?|mustaches?|moustaches?|goatees?|stubble|sunglasses|glasses|tattoos?|hair|ponytails?|braids|dreadlocks|piercings?|freckles|makeup|expressions?|beanies?|backward caps?|baseball caps?|hoodies?';
const _WORN_ANY = `${_WORN}|microphones?|mics?|earbuds?|earphones?|belts?|gloves|boots|shoes|sneakers|jeans|pants|shorts|necklaces?|chains?|earrings|watch(?:es)?|uniforms?|clothes|clothing|gear|costumes?|wigs?|crowns?|goggles|visors?|lanyards?|tops?|neckties?|bow ties?|ties?|headbands?|garments?|turbans?`;
const _WORN_NP = `${_ART}(?:[\\w'-]+\\s+){0,3}?\\b(?:${_WORN_ANY})\\b(?:\\s+(?:on|around|over|across)\\s+(?:his|her|their|the|its)\\s+(?:head|neck|face|forehead|shoulders?|ears?|eyes|chest))?(?:\\s+with\\s+(?:(?:a|an)\\s+)?(?:[\\w'-]+\\s+){0,2}?(?:zippers?|logos?|prints?|patterns?|designs?|graphics?|hoods?|stripes?|collars?|text|eyes|ears|horns|patch(?:es)?|badges?|stickers?|emblems?|lettering|writing|trim|buttons|accents|embellishments|details|sleeves))?`;
const _WEARING = new RegExp(`,?\\s*(?:who\\s+(?:is\\s+)?|while\\s+|and\\s+)?(?<!-)\\b(?:wearing|wears|dressed in|sporting)\\s+${_WORN_NP}(?:\\s*(?:,|and|or|with|over|under)\\s+${_WORN_NP})*`, 'gi');
const _IN_WORN = new RegExp(`\\s+in\\s+(?:(?:a|an|the|his|her|their)\\s+)?(?:[\\w'-]+\\s+){0,3}?\\b(?:${_WORN})\\b(?:\\s+(?:and|or)\\s+${_ART}(?:[\\w'-]+\\s+){0,2}?\\b(?:${_WORN_ANY})\\b)*`, 'gi');
const _PERSON_WITH_WORN = new RegExp(`\\b((?:${_PEOPLE}|broadcaster|host|guy|gamer|player|viewer|someone|people|men|women|speaker|presenter)\\s+)with\\s+${_ART}(?:[\\w'-]+\\s+){0,3}?\\b(?:${_WORN_ANY}|${_FACE})\\b(?:\\s*(?:,|and|or)\\s+${_ART}(?:[\\w'-]+\\s+){0,2}?\\b(?:${_WORN_ANY}|${_FACE})\\b)*\\s*`, 'gi');
const _WITH_FACE = new RegExp(`\\s+with\\s+${_ART}(?:[\\w'-]+\\s+){0,2}?\\b(?:${_FACE})\\b(?:\\s*(?:,|and|or)\\s+${_ART}(?:[\\w'-]+\\s+){0,2}?\\b(?:${_FACE}|${_WORN})\\b)*`, 'gi');
const _WEARS_AND = new RegExp(`(?<!-)\\bwears\\s+${_WORN_NP}(?:\\s*(?:,|and|or|with|over|under)\\s+${_WORN_NP})*\\s+and\\s+(?=\\w)`, 'gi');
// "…, while the other wears a dusty t-shirt;" goes as a whole clause.
const _WEARS_CLAUSE = new RegExp(`,?\\s+(?:while|and|as|whereas)\\s+(?:the other|one|another|someone|he|she|they|the streamer|(?:a|the) (?:man|woman|person|guy))\\s+wears\\s+${_WORN_NP}(?:\\s*(?:,|and|or|with|over|under)\\s+${_WORN_NP})*(?=\\s*(?:[;,.!?]|$))`, 'gi');
// "a plaid/checkered shirt": a slashed pair of words before what is worn reads as one word, so the rules below see it.
const _SLASHED_WORN = new RegExp(`\\b([\\w'-]+)/[\\w'-]+(?=\\s+(?:[\\w'-]+\\s+){0,2}?(?:${_WORN_ANY})\\b)`, 'gi');
// ", with a blue jacket partially visible": a comma-led clause about clothes, whoever wears them, goes (clothes only:
// "a desk with a headset" stays).
const _WITH_CLOTHES = /,\s*with\s+(?:(?:a|an|the|their|his|her)\s+)?(?:[\w'-]+\s+){0,2}?(?:t-shirts?|shirts?|tees?|tank tops?|hoodies?|sweatshirts?|sweaters?|jackets?|coats?|vests?|outfits?|dress(?:es)?|jerseys?|suits?|robes?|outerwear)\b[^,.;!?]*(?:,(?=\s+(?:is|are|was|were)\s))?/gi;
function _noClothing(text) {
    return text.split(/("[^"]*"?|“[^”]*”?)/).map((part, i) => (i % 2 ? part : part
        .replace(_SLASHED_WORN, '$1')
        .replace(_WITH_CLOTHES, '')
        // A parenthetical clause taken out of the middle ("A third person, with a red cap, is shown") leaves no ",,".
        .replace(/\s*,\s*,\s*/g, ' ')
        .replace(/\b[\w-]+-wearing\s+/gi, '')
        .replace(_WEARS_AND, '')
        .replace(_WEARS_CLAUSE, '')
        .replace(/\b(?:casually|smartly|neatly|warmly|brightly|formally|well)[\s-]+dressed\s+/gi, '')
        .replace(_PERSON_WITH_WORN, '$1')
        .replace(_WEARING, '')
        .replace(_IN_WORN, '')
        .replace(_WITH_FACE, '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/,(?=[.;:!?])/g, '')
        .replace(/([:;]),/g, '$1')
        .replace(/ {2,}/g, ' '))).join('');
}
// Tags shown with public AI items ("red-beanie", "bearded", "man", "tanktop") follow the same rule: a tag naming
// clothing, hair, face, age or a person by gender is dropped.
const _LOOKS_TAG = new RegExp(`(?:^|[\\s_-])(?:${_WORN}|${_FACE}|${_LOOKS}|men|women|man|woman|boy|girl|guy|gal|kid|child|teen|teenager|lady|male|female|youth|shirtless|topless|tanktop|selfie)(?=$|[\\s_-])`, 'i');
// A short AI title that names looks ("Orange Shirt Kitchen Chat") cannot be repaired word by word: it is not used.
const _LOOKS_WORD = new RegExp(`\\b(?:${_WORN}|${_FACE}|${_LOOKS}|faces?|smil(?:e|ing)|body|skin|men|women|man|woman|boy|girl|guy|kid|child|teen|lady|male|female|shirtless|topless)\\b`, 'i');
// Names are not people (as noLooks spares them): "Iron Man Speedrun", "Pac-Man Marathon", "Spider-Man 2" are titles
// about a game or a character, so a hyphenated name and the few two-word ones are skipped before the word test.
const _NAMED = /\b(?:iron|mega|pac|ant|spider|bat|he|ray)[\s-]+(?:man|men|woman|women)\b|-(?:man|men|woman|women|boy|girl)\b/gi;
const _hasLooks = (t) => _LOOKS_WORD.test(String(t || '').replace(_NAMED, ' '));
function _noLooksTags(tags) {
    return (Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && t.trim() && !_LOOKS_TAG.test(t.trim()));
}
// Body language is the person too ("reacting with a thoughtful pose", "in a relaxed posture"): the phrase goes.
const _POSE = /,?\s*(?:(?:appearing|seeming|seemingly)\s+(?:to\s+be\s+)?)?(?:(?:reacting|sitting|standing|leaning|posing|looking|resting)\s+)?(?:with|in)\s+(?:an?|their|his|her)\s+(?:[\w-]+\s+){0,2}(?:pose|posture|expression|facial expression|stance)\b/gi;
// A guessed gender is a description of the person too (owner's rule: no looks, body, clothing, hair, age or guessed
// gender): "a man in a kitchen" is "a person in a kitchen", "two men" are "two people", "a male or female host" is "a
// host". Only after an article or a count, so names (Iron Man, Pac-Man, Spice Girls) and quoted speech stay.
const _GENDERED = 'man|woman|guy|gal|lady|gentleman';
const _GENDERED_ONE = new RegExp(`\\b(a|an|the|one|another|this|that|each|every)\\s+(?:${_GENDERED})\\b(?!-)`, 'gi');
const _GENDERED_MANY = new RegExp(`\\b(two|three|four|five|several|some|the|both|many|other|few|these|those|\\d+)\\s+(?:men|women|guys|gals|ladies|gentlemen)\\b`, 'gi');
// A pronoun is a guessed gender too: he and she are "the person", his and her (before a word) "their", him and her
// (after a verb or a preposition, or at the end) "them", himself and herself "themself", hers "theirs". Outside
// quotes only: what someone said stays word for word. "The person" keeps the verb as written ("he looks" → "the person
// looks"), which "they" would not.
const _HE_SHE = /\b(?:he|she)\b(?:'(s|d|ll)\b)?/gi;
const _HER_OBJECT = /\bher\b(?=\s*(?:[.,;:!?)\]"”]|$)|\s+(?:and|or|but|to|from|with|in|on|at|for|as|while|when|because|so|if|the|a|an|this|that|is|was|again|back|up|down|out|off|away|over|now|too|here|there|more|about|into|onto)\b)/gi;
const _PRONOUNS = [
    [/\b(?:himself|herself)\b/gi, 'themself'],
    [/\bhers\b/gi, 'theirs'],
    [/\bhim\b/gi, 'them'],
    [_HER_OBJECT, 'them'],
    [/\b(?:his|her)\b(?=\s+[\w'-])/gi, 'their'],
    [/\bhis\b/gi, 'theirs'],
];
const _CONTRACTED = { s: "'s", d: ' would', ll: ' will' };
function _noPronouns(part) {
    let out = part.replace(_HE_SHE, (m, c) => _cap(m, `the person${c ? _CONTRACTED[c.toLowerCase()] : ''}`));
    for (const [re, word] of _PRONOUNS) out = out.replace(re, (m) => _cap(m, word));
    return out;
}
const _GENDER_ADJ = /\b(?:(?:a|an)\s+)?(?:male|female)\s+(?:or|and|\/)\s+(?:male|female)\s+|\b(?:male|female)\s+(?=(?:hosts?|streamers?|players?|speakers?|presenters?|gamers?|voices?|narrators?|commentators?|figures?|characters?|broadcasters?|viewers?|individuals?|persons?|people)\b)/gi;
// What is left of a sentence about someone's hair, clothes or body ("a person adjusts their hair or clothing near the
// counter") cannot be repaired word by word: the sentence goes.
const _GROOMING = new RegExp('\\b(?:(?:their|his|her)\\s+(?:own\\s+)?(?:hair|beard|face|makeup|clothing|clothes|outfit|appearance|body|figure|looks)'
    // The face and body described ("smiling broadly, displaying white teeth and a beard") and clothes the word lists do
    // not name ("blue outerwear", "in outdoor gear"): the sentence goes. Things a person holds or reviews (headphones, a
    // headset on a desk) are not here.
    + '|beards?|mustaches?|moustaches?|teeth|grin(?:s|ning)?|smil(?:e|es|ing)\\s+(?:broadly|widely|warmly|at)|freckles|complexion|wrinkles'
    + '|hairstyles?|haircuts?|outerwear|(?:in|wearing)\\s+(?:[\\w-]+\\s+){0,2}gear|face\\s+shields?)\\b', 'i');
function _noGender(text) {
    return text.split(/("[^"]*"?|“[^”]*”?)/).map((part, i) => (i % 2 ? part : part
        .replace(_GENDER_ADJ, (m) => (/^an?\s/i.test(m) ? m.slice(0, m.indexOf(' ') + 1) : ''))
        .replace(_GENDERED_ONE, (m, art) => _cap(m, `${/^an$/i.test(art) ? 'a' : art.toLowerCase()} person`))
        .replace(_GENDERED_MANY, (m, n) => _cap(m, `${n.toLowerCase()} people`))
        .replace(/\ba\s+(?=[aeiou]\w*\s+(?:host|streamer|player|speaker|presenter|gamer|figure|character|broadcaster|person)\b)/gi, (m) => _cap(m, 'an '))
        .replace(/ {2,}/g, ' '))).map((part, i) => (i % 2 ? part : _noPronouns(part))).join('');
}
function _noGrooming(text) {
    const sentences = text.match(/[^.!?]+(?:[.!?]+(?:["”])?|$)\s*/g) || [text];
    return sentences.filter((s) => !_GROOMING.test(s.replace(/"[^"]*"?|“[^”]*”?/g, ''))).join('').trim();
}
function _noLooks(text) {
    if (!text || typeof text !== 'string') return text;
    return _noGrooming(_noGender(_noLooksWords(text)));
}
function _noLooksWords(text) {
    return _noClothing(text).replace(_POSE, '').replace(/\s+([,.;:!?])/g, '$1').replace(/ {2,}/g, ' ')
        // Looks named: the person on camera. Only an age ("a child sits nearby"): someone, who may not be the streamer.
        .replace(_LOOKED_AT, (m, art, looks, noun) => (looks ? _cap(m, 'the streamer') : _AGE_NOUN.test(noun) ? _cap(m, /^the$/i.test(art) ? 'the person' : 'someone') : m))
        .replace(_LOOKED_AT_BARE, (m) => _cap(m, 'streamer'))
        .replace(/\s+(?:is|are)\s+(?:shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed)\s+and\s+/gi, ' ')
        .replace(/\b(?:shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed)\s+and\s+/gi, '')
        .replace(/\b(one|the other|another),?\s+and\s+(?=\w+ing\b)/gi, '$1 ')
        .replace(/\s+(?:is|are)\s+(?:shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed)\b/gi, ' is on camera')
        .replace(/\s*,\s*(?:shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed)\s*,/gi, '')
        .replace(/\b(?:shirtless|topless|bare-chested|half-naked|semi-naked|naked|nude|semi-nude|undressed|unclothed)\b,?\s*/gi, '');
}

// FNV-1a over the rules' source, twice with different offsets: a stable 16-hex-digit version.
function _hash(text) {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const RULES_VERSION = _hash([_NAMED, _LOOKS, _PEOPLE, _WORN, _WORN_ANY, _FACE, _WITH_CLOTHES, _GENDER_ADJ, _GROOMING, _LOOKS_TAG, _LOOKS_WORD, _POSE,
    _noLooks, _noLooksWords, _noGender, _noGrooming, _noClothing, _HE_SHE, _HER_OBJECT, _PRONOUNS.map(([re, w]) => `${re}${w}`).join(','), _noPronouns].map(String).join('|'));

module.exports = { noLooks: _noLooks, noLooksTags: _noLooksTags, hasLooks: _hasLooks, RULES_VERSION };
