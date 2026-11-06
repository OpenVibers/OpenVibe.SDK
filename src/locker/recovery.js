'use strict';
/**
 * The recovery phrase: the words a person writes down.
 *
 * A phrase of n words from the same 256-word list the fingerprint uses, one byte per word from
 * the platform's CSPRNG (crypto.getRandomValues). Eight bits per word, so the usual 24 words
 * carry 192 bits: enough for a key nobody else has, and short enough to write on paper.
 *
 * There is no checksum in the phrase: the words are the secret, and a phrase that is typed
 * wrong simply does not open anything. isRecoveryPhrase only says whether every word is one of
 * the 256, so a UI can tell a typo from a word that was never in the list.
 */
const { fail } = require('./errors');
const { platformRandom } = require('./keys');
const { WORDS } = require('./words');

/** How many words a recovery phrase has, unless the caller says otherwise. */
const RECOVERY_WORDS = 24;

/**
 * A recovery phrase: n words from the list, one byte each.
 *
 *   recoveryWords()      // 24 words, 192 bits
 *   recoveryWords(12)    // 12 words, 96 bits
 */
function recoveryWords(count = RECOVERY_WORDS, { random = platformRandom } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > WORDS.length) {
        fail('locker.invalid', `A recovery phrase is one to ${WORDS.length} words`);
    }
    // One byte per word: the list has 256 words, so a byte picks one of them exactly.
    const bytes = random(count);
    const words = [];
    for (const byte of bytes) words.push(WORDS[byte]);
    return words.join(' ');
}

/**
 * Whether a typed phrase is made of words from the list. It says nothing about the order or
 * about whether the phrase is the right one: only that every word could have come from us.
 */
function isRecoveryPhrase(phrase) {
    if (typeof phrase !== 'string') return false;
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    return words.every(word => WORDS.includes(word.toLowerCase()));
}

module.exports = { RECOVERY_WORDS, recoveryWords, isRecoveryPhrase };
