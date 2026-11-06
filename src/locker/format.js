'use strict';
/**
 * The Locker envelope on the wire (locker.envelope@1). This file is the format and nothing
 * else: the numbers, the framing and the associated data. The cryptography lives in keys.js
 * and seal.js; the rules for a service that only reads the header live in server.js.
 *
 *   0      4      8                          8 + header length
 *   +------+------+--------------------------+--------------------------+
 *   | OVLK | len  | header JSON (UTF-8)      | chunk frames             |
 *   +------+------+--------------------------+--------------------------+
 *
 *   each chunk frame:
 *   0      4      5                          17
 *   +------+------+--------------------------+--------------------------+
 *   | len  | flags| nonce (12 bytes)         | ciphertext + 16-byte tag |
 *   +------+------+--------------------------+--------------------------+
 */
const { utf8, fromUtf8, concat, base64, fromBase64, u32be, readU32be, canonicalJson } = require('./bytes');
const { fail } = require('./errors');
const { padme } = require('./padme');

/** The four bytes that say "this is a Locker envelope". */
const MAGIC = 'OVLK';
/** The format this library reads and writes. */
const VERSION = 'locker.envelope.v1';
/** The only suite in this version: AES-256-GCM, a 32-byte key. */
const SUITE = 'AES-256-GCM';
/** The chunk size in bytes: 1 MiB. */
const CHUNK_SIZE = 1048576;
/** The GCM tag is appended to the ciphertext. */
const TAG_SIZE = 16;
/** The GCM nonce is 12 bytes. */
const NONCE_SIZE = 12;
/** The first half of every nonce: eight random bytes, in the header. */
const NONCE_BASE_SIZE = 8;
/** The padded plaintext starts with the true length, as eight bytes. */
const LENGTH_PREFIX = 8;
/**
 * The smallest padded plaintext we write. A short note still costs 256 bytes: below that the
 * padded length would say too much about the real one (Padmé's grid is coarse down there), and
 * 256 bytes is nothing next to a chunk.
 */
const MIN_PADDED_SIZE = 256;
/** A header is small. A bigger one is not a header we wrote, and a service must not read it. */
const MAX_HEADER_BYTES = 65536;
/** The bit that marks the last chunk of an envelope. */
const FINAL_FLAG = 0x01;

/**
 * The header fields every chunk authenticates. The slots are not in here, on purpose: adding a
 * member to a people-locked item re-wraps the content key without re-encrypting the content, so
 * the core cannot change either. Each slot is authenticated by its own tag instead.
 */
function coreOf(header) {
    return {
        version: header.version,
        suite: header.suite,
        chunk_size: header.chunk_size,
        padded_size: header.padded_size,
        nonce_base: header.nonce_base,
        lock: header.lock,
    };
}

/** The canonical JSON of the core: the same bytes on both sides, whatever order the header was written in. */
function coreBytes(header) { return utf8(canonicalJson(coreOf(header))); }

/** The associated data of one chunk: the core, the chunk counter and the flags. */
function chunkAad(header, counter, flags) {
    return concat(coreBytes(header), u32be(counter), Uint8Array.of(flags));
}

/** The header as the bytes that go on the wire. */
function encodeHeader(header) { return utf8(canonicalJson(header)); }

/** The header's JSON bytes, as they were written. */
function decodeHeader(headerBytes) {
    let header;
    try { header = JSON.parse(fromUtf8(headerBytes)); }
    catch { fail('locker.bad_envelope', 'The envelope header is not JSON'); }
    return header;
}

/** The whole envelope: the magic, the header and the chunks. */
function encodeEnvelope(headerBytes, chunks) {
    return concat(utf8(MAGIC), u32be(headerBytes.length), headerBytes, chunks);
}

/**
 * Reads the header out of envelope bytes. It stops at the header: the chunks are not touched,
 * so this is safe to do on bytes that are not an envelope at all.
 */
function readHeader(bytes) {
    if (!bytes || bytes.length < 8) fail('locker.bad_envelope', 'The envelope is too short to hold a header');
    const magic = fromUtf8(bytes.slice(0, 4));
    if (magic !== MAGIC) fail('locker.bad_envelope', 'These bytes are not a Locker envelope');
    const headerLength = readU32be(bytes, 4);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
        fail('locker.bad_envelope', `The envelope header is ${headerLength} bytes, which is not one we write`);
    }
    if (bytes.length < 8 + headerLength) fail('locker.truncated', 'The envelope ends inside its header');
    const headerBytes = bytes.slice(8, 8 + headerLength);
    return { header: decodeHeader(headerBytes), headerBytes, chunkOffset: 8 + headerLength };
}

/**
 * How many chunks a padded plaintext of this size takes. Every chunk but the last is a whole
 * chunk; the last holds what is left of it.
 */
function chunkCount(padded) { return Math.max(1, Math.ceil(padded / CHUNK_SIZE)); }

/** How many bytes the last chunk of a padded plaintext of this size holds: more than zero. */
function lastChunkSize(padded) { return padded - (chunkCount(padded) - 1) * CHUNK_SIZE; }

/**
 * The padded size of a content of this size: the length prefix plus the content, padded with
 * Padmé up to the next size on its grid, and never below the floor.
 */
function paddedSize(size) { return Math.max(MIN_PADDED_SIZE, padme(LENGTH_PREFIX + size)); }

/** The nonce of a chunk: the header's base, then the counter. No nonce repeats inside an envelope. */
function chunkNonce(nonceBase, counter) {
    const nonce = new Uint8Array(NONCE_SIZE);
    nonce.set(nonceBase, 0);
    new DataView(nonce.buffer).setUint32(8, counter >>> 0, false);
    return nonce;
}

/** One chunk frame: its length, its flags, its nonce and the ciphertext with the tag. */
function encodeChunk(counter, flags, nonce, ciphertext) {
    return concat(u32be(ciphertext.length), Uint8Array.of(flags), nonce, ciphertext);
}

/** The header's nonce base as bytes. */
function nonceBaseBytes(header) {
    const bytes = fromBase64(header.nonce_base);
    if (bytes.length !== NONCE_BASE_SIZE) fail('locker.bad_envelope', 'The envelope nonce base is not eight bytes');
    return bytes;
}

module.exports = {
    MAGIC, VERSION, SUITE, CHUNK_SIZE, TAG_SIZE, NONCE_SIZE, NONCE_BASE_SIZE, LENGTH_PREFIX,
    MIN_PADDED_SIZE, MAX_HEADER_BYTES, FINAL_FLAG,
    coreOf, coreBytes, chunkAad, encodeHeader, decodeHeader, encodeEnvelope, readHeader,
    chunkCount, lastChunkSize, paddedSize, chunkNonce, encodeChunk, nonceBaseBytes,
};
