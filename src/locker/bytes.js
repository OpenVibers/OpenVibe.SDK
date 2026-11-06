'use strict';
/**
 * Byte helpers for the Locker envelope. Framing only, no cryptography: every value is a
 * Uint8Array, so the same code runs in Node and in the browser.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 bytes of a string. */
function utf8(text) { return encoder.encode(text); }

/** The string of UTF-8 bytes. */
function fromUtf8(bytes) { return decoder.decode(bytes); }

/** One buffer of all the parts, in order. */
function concat(...parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

/** Standard base64. btoa/atob are in every browser and in Node. */
function base64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** The bytes of a standard base64 string. */
function fromBase64(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** base64url: the same alphabet without the padding, for keys that travel in a URL. */
function base64url(bytes) { return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** The bytes of a base64url string. */
function fromBase64url(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    return fromBase64(padded);
}

/** A number as four bytes, big endian. */
function u32be(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, false);
    return out;
}

/** The number four bytes at `at` hold, big endian. */
function readU32be(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false); }

/** A number as eight bytes, big endian. */
function u64be(value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
    return out;
}

/** The number eight bytes at `at` hold, big endian. */
function readU64be(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, false); }

/**
 * The canonical JSON of a value: object keys sorted, no whitespace. Two sides that hold the
 * same value therefore hold the same bytes, which is what a signature or an associated data
 * needs. (JSON.stringify would keep the order the object was built in, which is not a promise
 * we can make across two implementations.)
 */
function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

module.exports = {
    utf8, fromUtf8, concat, base64, fromBase64, base64url, fromBase64url,
    u32be, readU32be, u64be, readU64be, canonicalJson,
};
