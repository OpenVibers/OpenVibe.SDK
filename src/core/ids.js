'use strict';
/**
 * Identifiers, browser-safe (Web Crypto getRandomValues; no Node modules).
 * ULIDs match openvibe-contracts ids.ulid(): Crockford base32, 48-bit ms time + 80-bit randomness.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n) {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== 'function') throw new Error('openvibe-sdk: Web Crypto (globalThis.crypto) is required');
    return c.getRandomValues(new Uint8Array(n));
}

function randomHex(nBytes) {
    let out = '';
    for (const b of randomBytes(nBytes)) out += b.toString(16).padStart(2, '0');
    return out;
}

function ulid(now = Date.now()) {
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    let rand = '';
    for (const b of randomBytes(16)) rand += ALPHABET[b & 31];   // 256 is a multiple of 32: unbiased
    return time + rand;
}

/** evt_<ULID>, the event id format of events.event-envelope@1. */
function newEventId(now) {
    return `evt_${ulid(now)}`;
}

/** A fresh Idempotency-Key value. */
function newIdempotencyKey() {
    return `idem_${ulid()}`;
}

const SUBJECT_RE = { user: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/, guest: /^gst_[0-9A-HJKMNP-TV-Z]{26}$/ };

/** Is this a usr_… or gst_… subject id (the ids a service may act for)? */
function isActingSubjectId(id) {
    return typeof id === 'string' && (SUBJECT_RE.user.test(id) || SUBJECT_RE.guest.test(id));
}

module.exports = { ulid, newEventId, newIdempotencyKey, randomBytes, randomHex, isActingSubjectId };
