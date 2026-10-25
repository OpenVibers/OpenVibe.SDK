'use strict';
/**
 * openvibe-sdk/front-page — what may lead a site's front page, read by everyone who arrives: a list of the latest or
 * most viewed things, a quote strip, a feed. A title or line with one of the built-in slur categories, strong
 * profanity (English, Portuguese, Spanish, French, German) or a hate topic out of context is left off the front
 * page and the next one shown; the thing itself stays where it is (its own page, its own room).
 *
 * 2026-10-24: an anonymous screenshot paste titled with a slur sat in OpenVibe.Community's "Most viewed"; OpenVibe.Live
 * applied the same rule to its "Lately on OpenVibe" quotes (Live#345/#346, server/home/front-page-text.js).
 *
 * The slur categories and their normalization are OpenVibe.Chat's built-in ones (server/chat/moderation-utils.js:
 * leet mapping, accents stripped, letters spaced out or run together), ported unchanged. Defensive moderation: this
 * file adds no term; tests build their cases at run time.
 */

const LEET_MAP = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

const CORE_SLUR_CATEGORIES = [
    { key: 'n_word', patterns: ['\\bn+i+g+g+(?:a+[sz]?|e+r+[sz]?)\\b', '\\b[kn]*n+h?i+c?k+e+r+s?\\b'] },
    {
        key: 'antisemitic',
        patterns: [
            '\\bk+\\s*y+\\s*k+\\s*e+\\b',
            '\\bj+\\s*e+\\s*w+\\s*s?\\s+w+\\s*i+\\s*l+\\s*l+\\s+n+\\s*o+\\s*t+\\s+r+\\s*e+\\s*p+\\s*l+\\s*a+\\s*c+\\s*e+\\b',
        ],
    },
    { key: 'homophobic', patterns: ['\\bf+\\s*a+\\s*g+(?:o+\\s*t+)?[sz]?\\b'] },
    { key: 'racial', patterns: ['\\bs+\\s*p+\\s*i+\\s*c+[sz]?\\b', '\\bc+\\s*h+\\s*i+\\s*n+\\s*k+[sz]?\\b'] },
].map((c) => ({ ...c, compiled: c.patterns.map((p) => new RegExp(p, 'i')) }));

/** Lowercase, leet mapped, accents stripped, every run of other characters one space. */
function _normalize(input) {
    const mapped = String(input || '').toLowerCase().split('').map((ch) => LEET_MAP[ch] || ch).join('');
    return mapped.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the text has one of the built-in slur categories, spaced out or run together included. */
function containsCoreSlur(text) {
    const normalized = _normalize(text);
    if (!normalized) return false;
    const candidates = [normalized, normalized.replace(/\s+/g, '')];
    return CORE_SLUR_CATEGORIES.some((c) => candidates.some((x) => c.compiled.some((re) => re.test(x))));
}

const _ROUGH = /\b(?:f+u+c+k\w*|motherf\w*|sh[i1]t(?:s|ty|ting|ted)?|bullshit|cunts?|bitch\w*|whores?|sluts?|pussy|retard\w*|nazis?|hitler|holocaust|anti-?semit\w*|kkk|rap(?:e|ed|es|ist|ists|ing))\b/i;
// Letter boundaries, not \b: \b does not know ç, ñ or ß.
const _ROUGH_INTL = /(?<!\p{L})(?:caralho|porra|foda(?:-se)?|fodase|merda|putas?|viado|buceta|mierda|joder|coño|pendejos?|cabr[oó]n(?:es)?|verga|chinga\p{L}*|putain|merde|connard|salope|scheiße|scheisse|hurensohn|ficken|fick)(?!\p{L})/iu;

/** True when the text may lead a front page: not empty, no slur, no strong profanity, no hate topic. */
function frontPageOk(text) {
    const t = String(text == null ? '' : text);
    if (!t.trim() || _ROUGH.test(t) || _ROUGH_INTL.test(t)) return false;
    return !containsCoreSlur(t);
}

module.exports = { frontPageOk, containsCoreSlur };
