'use strict';
/**
 * seal and open: the content, the three locks, and the streams.
 *
 * The envelope is written once and read once. Every chunk is sealed with AES-256-GCM under the
 * content key, with the header's core, the chunk counter and the flags as associated data, so a
 * chunk cannot be cut, reordered or truncated without the open failing.
 */
const {
    utf8, fromUtf8, concat, base64, base64url, fromBase64url, u32be, readU32be, u64be, readU64be,
} = require('./bytes');
const { fail } = require('./errors');
const {
    MAGIC, VERSION, SUITE, CHUNK_SIZE, TAG_SIZE, NONCE_BASE_SIZE, LENGTH_PREFIX, MIN_PADDED_SIZE,
    FINAL_FLAG, coreOf, chunkAad, encodeHeader, encodeEnvelope, readHeader, chunkCount,
    lastChunkSize, paddedSize, chunkNonce, encodeChunk, nonceBaseBytes,
} = require('./format');
const {
    KEY_BYTES, PASSWORD_ITERATIONS, subtle, platformRandom, importContentKey, publicJwk,
    jwkThumbprint, wrapFor, unwrapPeopleSlot, wrapForPassword, unwrapPasswordSlot, resolveEphemeral,
} = require('./keys');

/** The content as bytes: a string is UTF-8, anything else is taken as it is. */
function toBytes(content) {
    if (typeof content === 'string') return utf8(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    fail('locker.invalid', 'The content must be a string or bytes');
}

/** The bytes of an envelope: what seal returns, or what the caller kept. */
function envelopeBytes(envelope) {
    if (envelope instanceof Uint8Array) return envelope;
    if (envelope && envelope.bytes instanceof Uint8Array) return envelope.bytes;
    fail('locker.invalid', 'That is not a Locker envelope');
}

/** A source of bytes: an async iterable of Uint8Array. */
async function* once(bytes) { yield bytes; }

/**
 * Collects bytes into blocks of a fixed size, without ever holding more than one block and the
 * part that has not been used yet. This is what keeps a stream seal in constant memory.
 */
class Chunker {
    constructor(size) { this.size = size; this.parts = []; this.length = 0; }

    push(part) { this.parts.push(part); this.length += part.length; }

    /** The next full block, or null when there is not enough yet. */
    take() {
        if (this.length < this.size) return null;
        const block = new Uint8Array(this.size);
        let at = 0;
        while (at < this.size) {
            const head = this.parts[0];
            const take = Math.min(head.length, this.size - at);
            block.set(head.subarray(0, take), at);
            at += take;
            if (take === head.length) this.parts.shift();
            else this.parts[0] = head.subarray(take);
        }
        this.length -= this.size;
        return block;
    }

    /** What is left, as one block of exactly this many bytes: the bytes that are there, then zeros. */
    takeExactly(count) {
        if (this.length > count) fail('locker.size_mismatch', 'The content is longer than the size it was given');
        const block = new Uint8Array(count);
        let at = 0;
        for (const part of this.parts) { block.set(part, at); at += part.length; }
        this.parts = [];
        this.length = 0;
        return block;
    }
}

/** The header, the content key and the nonce base: everything a seal needs before it writes. */
async function prepare(options) {
    const lock = options.lock;
    if (!['people', 'password', 'link'].includes(lock)) {
        fail('locker.invalid', 'A lock is people, password or link');
    }
    const random = options.random || platformRandom;
    const contentKey = options.contentKey ? toBytes(options.contentKey) : random(KEY_BYTES);
    if (contentKey.length !== KEY_BYTES) fail('locker.invalid', 'The content key is 32 bytes');
    const nonceBase = options.nonceBase ? toBytes(options.nonceBase) : random(NONCE_BASE_SIZE);
    if (nonceBase.length !== NONCE_BASE_SIZE) fail('locker.invalid', 'The nonce base is eight bytes');
    let slots;
    if (lock === 'people') {
        const keys = options.keys || [];
        if (!keys.length) fail('locker.invalid', 'A people lock needs at least one recipient');
        // One ephemeral key pair for the whole envelope: the shared secret differs per person.
        const pair = await resolveEphemeral(options.ephemeral);
        const people = [];
        for (const key of keys) {
            people.push(await wrapFor(contentKey, key.publicKey, {
                subject: key.subject, random, ephemeral: pair,
            }));
        }
        slots = { people };
    } else if (lock === 'password') {
        slots = {
            password: await wrapForPassword(contentKey, options.password, {
                salt: options.salt, iterations: options.iterations || PASSWORD_ITERATIONS, random,
            }),
        };
    } else {
        // A link lock stores no key: the content key travels in the part of the link after the #.
        slots = { link: {} };
    }
    return { contentKey, nonceBase, slots };
}

/** The header of an envelope. */
function makeHeader(lock, slots, padded, nonceBase) {
    return {
        version: VERSION,
        suite: SUITE,
        chunk_size: CHUNK_SIZE,
        padded_size: padded,
        nonce_base: base64(nonceBase),
        lock,
        slots,
    };
}

/** Seals one block of the padded plaintext. */
async function sealBlock(key, header, nonceBase, counter, block, isFinal) {
    const flags = isFinal ? FINAL_FLAG : 0;
    const nonce = chunkNonce(nonceBase, counter);
    const ciphertext = new Uint8Array(await subtle().encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: chunkAad(header, counter, flags) },
        key,
        block,
    ));
    return encodeChunk(counter, flags, nonce, ciphertext);
}

/**
 * The envelope, piece by piece. The header comes first (it holds the padded size, so the size
 * has to be known before the first byte is written), then one frame per chunk.
 */
async function* sealPieces(source, options) {
    const size = options.size;
    const { contentKey, nonceBase, slots } = await prepare(options);
    const padded = paddedSize(size);
    const header = makeHeader(options.lock, slots, padded, nonceBase);
    const headerBytes = encodeHeader(header);
    yield { header, headerBytes, contentKey, bytes: concat(utf8(MAGIC), u32be(headerBytes.length), headerBytes) };
    const key = await importContentKey(contentKey, ['encrypt']);
    const total = chunkCount(padded);
    const chunker = new Chunker(CHUNK_SIZE);
    let counter = 0;
    // The padded plaintext starts with the true length, so the server cannot read the size.
    chunker.push(u64be(size));
    for await (const part of source) {
        chunker.push(part);
        // Every chunk but the last is a whole chunk.
        for (;;) {
            if (counter >= total - 1) break;
            const block = chunker.take();
            if (!block) break;
            yield { bytes: await sealBlock(key, header, nonceBase, counter, block, false) };
            counter++;
        }
    }
    // The content is done; the padding fills the rest of the padded plaintext. (A content that
    // is longer than the size it was given fails in takeExactly, below.)
    while (counter < total - 1) {
        const block = chunker.takeExactly(CHUNK_SIZE);
        yield { bytes: await sealBlock(key, header, nonceBase, counter, block, false) };
        counter++;
    }
    // The last chunk: what is left of the plaintext, then zeros up to the padded size.
    const tail = chunker.takeExactly(lastChunkSize(padded));
    yield { bytes: await sealBlock(key, header, nonceBase, counter, tail, true) };
}

/**
 * Seals content: a string or bytes. The result holds the envelope's bytes and its header.
 *
 *   seal('a note', { lock: 'password', password: 'correct horse' })
 *   seal(bytes, { lock: 'people', keys: [{ subject, publicKey }] })
 *   seal(bytes, { lock: 'link' })            // the key comes back as linkKey
 */
async function seal(content, options = {}) {
    const bytes = toBytes(content);
    const pieces = [];
    let header = null;
    let headerBytes = null;
    let contentKey = null;
    for await (const piece of sealPieces(once(bytes), { ...options, size: bytes.length })) {
        if (piece.header) { header = piece.header; headerBytes = piece.headerBytes; contentKey = piece.contentKey; }
        pieces.push(piece.bytes);
    }
    const envelope = {
        version: VERSION,
        header,
        headerBytes,
        bytes: concat(...pieces),
        chunkOffset: 8 + headerBytes.length,
    };
    if (options.lock === 'link') {
        // The link carries the content key; the envelope itself stores nothing.
        envelope.linkKey = base64url(contentKey);
    }
    return envelope;
}

/** The header's core, as a reader needs it: the fields must be the ones we write. */
function readCore(header) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
        fail('locker.bad_envelope', 'The envelope header is not an object');
    }
    if (header.version !== VERSION) fail('locker.bad_envelope', 'This envelope is another version');
    if (header.suite !== SUITE) fail('locker.bad_envelope', 'This envelope uses another suite');
    if (header.chunk_size !== CHUNK_SIZE) fail('locker.bad_envelope', 'This envelope uses another chunk size');
    if (!Number.isInteger(header.padded_size) || header.padded_size < MIN_PADDED_SIZE) {
        fail('locker.bad_envelope', 'The padded size is not a size we write');
    }
    if (!['people', 'password', 'link'].includes(header.lock)) {
        fail('locker.bad_envelope', 'The lock is not one we know');
    }
    if (!header.slots || typeof header.slots !== 'object') {
        fail('locker.bad_envelope', 'The envelope has no slots');
    }
    return header;
}

/** The content key out of the header, with the credentials the reader has. */
async function openContentKey(header, credentials = {}) {
    // A caller that still holds the content key needs no private key: an agent that sealed the item
    // can open it, or wrap it for the people who stay, with the key it kept. A string is base64url,
    // as the link key travels.
    if (credentials.contentKey) {
        const given = typeof credentials.contentKey === 'string'
            ? fromBase64url(credentials.contentKey) : toBytes(credentials.contentKey);
        if (given.length !== KEY_BYTES) fail('locker.invalid', 'The content key is 32 bytes');
        return given;
    }
    if (header.lock === 'people') {
        // A person may be named by their key instead of their subject: the slot says which key
        // it is for, so the reader does not need to know who they are.
        if (credentials.person) {
            const slot = await slotForPerson(header, credentials.person);
            const privateKey = await importPrivateKey(privateKeyOf(credentials.person) || credentials.privateKey);
            if (!privateKey) fail('locker.no_key', 'A people lock needs the private key of a recipient');
            return unwrapPeopleSlot(slot, privateKey);
        }
        const slot = pickSlot(header, credentials.subject);
        const privateKey = await importPrivateKey(credentials.privateKey);
        if (!privateKey) fail('locker.no_key', 'A people lock needs the private key of a recipient');
        return unwrapPeopleSlot(slot, privateKey);
    }
    if (header.lock === 'password') {
        if (!credentials.password) fail('locker.no_key', 'A password lock needs the password');
        if (!header.slots.password) fail('locker.bad_envelope', 'The envelope has no password slot');
        return unwrapPasswordSlot(header.slots.password, credentials.password);
    }
    if (!credentials.key) fail('locker.no_key', 'A link lock needs the key from the link');
    const key = typeof credentials.key === 'string' ? fromBase64url(credentials.key) : toBytes(credentials.key);
    if (key.length !== KEY_BYTES) fail('locker.invalid', 'The link key is 32 bytes');
    return key;
}

/** The slot of the person who is opening: theirs, or the only one there is. */
function pickSlot(header, subject) {
    const slots = (header.slots && header.slots.people) || [];
    if (!slots.length) fail('locker.bad_envelope', 'The envelope has no people slots');
    if (subject) {
        const id = typeof subject === 'string' ? subject : subject.id;
        const type = typeof subject === 'string' ? null : subject.type;
        const found = slots.find(slot => slot.subject.id === id && (type === null || slot.subject.type === type));
        if (!found) fail('locker.no_key', 'This envelope has no slot for that person');
        return found;
    }
    if (slots.length > 1) fail('locker.no_key', 'This envelope has several slots: say which person you are');
    return slots[0];
}

/** The ECDH public key of a person, as a JWK. */
async function publicKeyOf(person) {
    if (!person || typeof person !== 'object') fail('locker.invalid', 'A people lock needs the person');
    if (person.ecdhPublic) return publicJwk(person.ecdhPublic);
    if (person.ecdh && person.ecdh.kty) return publicJwk(person.ecdh);
    if (person.kty === 'EC') return publicJwk(person);
    if (person.ecdh && person.ecdh.publicKey) {
        return publicJwk(await subtle().exportKey('jwk', person.ecdh.publicKey));
    }
    fail('locker.invalid', 'The person has no ECDH public key');
}

/** The ECDH private key of a person, if they brought one. */
function privateKeyOf(person) {
    if (!person || typeof person !== 'object') return null;
    if (person.ecdh && person.ecdh.privateKey) return person.ecdh.privateKey;
    if (person.ecdhPrivateKey) return person.ecdhPrivateKey;
    if (person.privateKey) return person.privateKey;
    return null;
}

/**
 * The slot that names this person's key. Every people slot carries the thumbprint of the key
 * it was made for, so the reader finds its own slot without knowing anybody's subject. An
 * envelope that has no slot for this key is not an envelope this person can open: that is
 * locker.no_slot, which says the key is not on the list (not that the key is wrong).
 */
async function slotForPerson(header, person) {
    const slots = (header.slots && header.slots.people) || [];
    if (!slots.length) fail('locker.bad_envelope', 'The envelope has no people slots');
    const thumbprint = await jwkThumbprint(await publicKeyOf(person));
    const found = slots.find(slot => slot.recipient_key === thumbprint);
    if (!found) fail('locker.no_slot', 'This envelope has no slot for that key');
    return found;
}

/** A private key as WebCrypto wants it: a CryptoKey, or a JWK to import. */
async function importPrivateKey(key) {
    if (!key) return null;
    if (key.type === 'private' && key.algorithm && key.algorithm.name === 'ECDH') return key;
    if (key.kty === 'EC' && key.crv === 'P-256' && key.d) {
        try {
            return await subtle().importKey('jwk', key, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        } catch {
            fail('locker.invalid', 'The private key is not a P-256 key');
        }
    }
    fail('locker.invalid', 'The private key must be an ECDH P-256 key');
}

/** Reads exact byte counts out of an envelope that is already in memory. */
function arrayReader(bytes) {
    let at = 0;
    return {
        /** The next bytes, or null when the envelope is over. */
        async probe(count) {
            if (at >= bytes.length) return null;
            return this.take(count);
        },
        async take(count) {
            if (at + count > bytes.length) fail('locker.truncated', 'The envelope ends inside a chunk');
            const out = bytes.slice(at, at + count);
            at += count;
            return out;
        },
    };
}

/** Reads exact byte counts out of a stream, keeping only what it must. */
function streamReader(iterator) {
    let buffer = new Uint8Array(0);
    let ended = false;
    async function fill(count) {
        while (buffer.length < count && !ended) {
            const next = await iterator.next();
            if (next.done) { ended = true; break; }
            buffer = buffer.length ? concat(buffer, next.value) : next.value;
        }
        return buffer.length;
    }
    return {
        /** The next bytes, or null when the stream is over. */
        async probe(count) {
            const have = await fill(count);
            if (have === 0) return null;
            return this.take(count);
        },
        async take(count) {
            const have = await fill(count);
            if (have < count) fail('locker.truncated', 'The envelope ends inside a chunk');
            const out = buffer.slice(0, count);
            buffer = buffer.slice(count);
            return out;
        },
    };
}

/**
 * Opens the chunks: the plaintext, piece by piece. The reader may be an envelope in memory or a
 * stream; both are read the same way, so the same checks run on both.
 */
async function* openPieces(reader, header, key) {
    const expected = chunkCount(header.padded_size);
    const lastLength = lastChunkSize(header.padded_size);
    const nonceBase = nonceBaseBytes(header);
    let counter = 0;
    let length = null;
    let emitted = 0;
    for (;;) {
        const lengthBytes = await reader.probe(4);
        if (lengthBytes === null) {
            if (counter !== expected) fail('locker.truncated', 'The envelope ends before its last chunk');
            break;
        }
        if (counter >= expected) fail('locker.bad_envelope', 'The envelope has more chunks than its size says');
        const cipherLength = readU32be(lengthBytes, 0);
        // The length is checked before it is used: a header that claims a huge chunk must not
        // make the reader wait for it. Every chunk but the last is a whole chunk; the last holds
        // what is left of the padded size.
        const wantedLength = counter === expected - 1 ? lastLength : CHUNK_SIZE;
        if (cipherLength !== wantedLength + TAG_SIZE) {
            fail('locker.bad_envelope', 'A chunk is not the size the envelope says');
        }
        const flags = (await reader.take(1))[0];
        const nonce = await reader.take(12);
        const ciphertext = await reader.take(cipherLength);
        const isFinal = (flags & FINAL_FLAG) === FINAL_FLAG;
        if (isFinal !== (counter === expected - 1)) {
            fail('locker.bad_envelope', 'The envelope marks the wrong chunk as the last one');
        }
        const wanted = chunkNonce(nonceBase, counter);
        for (let i = 0; i < wanted.length; i++) {
            if (nonce[i] !== wanted[i]) fail('locker.bad_envelope', 'A chunk carries the wrong nonce');
        }
        let plain;
        try {
            plain = new Uint8Array(await subtle().decrypt(
                { name: 'AES-GCM', iv: nonce, additionalData: chunkAad(header, counter, flags) },
                key,
                ciphertext,
            ));
        } catch (err) {
            if (err && err.code) throw err;
            fail('locker.wrong_key', 'This envelope does not open with this key');
        }
        if (counter === 0) {
            if (plain.length < LENGTH_PREFIX) fail('locker.bad_envelope', 'The first chunk is too short');
            length = Number(readU64be(plain, 0));
            if (length > header.padded_size - LENGTH_PREFIX) {
                fail('locker.size_mismatch', 'The content is longer than the envelope says');
            }
        }
        const start = counter === 0 ? LENGTH_PREFIX : 0;
        const part = plain.subarray(start);
        const room = length - emitted;
        const out = part.length > room ? part.subarray(0, room) : part;
        emitted += out.length;
        counter++;
        if (out.length) yield out;
    }
    if (emitted !== length) fail('locker.size_mismatch', 'The envelope holds fewer bytes than it says');
}

/**
 * Opens an envelope: the content as bytes.
 *
 *   open(envelope, { privateKey, subject })   // a people lock, by subject
 *   open(envelope, { person })                // a people lock, by key
 *   open(envelope, { password })               // a password lock
 *   open(envelope, { key })                    // a link lock
 */
async function open(envelope, credentials = {}) {
    const bytes = envelopeBytes(envelope);
    const { header, chunkOffset } = readHeader(bytes);
    readCore(header);
    const contentKey = await openContentKey(header, credentials);
    const key = await importContentKey(contentKey, ['decrypt']);
    const reader = arrayReader(bytes.subarray(chunkOffset));
    const parts = [];
    for await (const part of openPieces(reader, header, key)) parts.push(part);
    return concat(...parts);
}

/** A stream of the bytes of a WHATWG stream (or of any async iterable of bytes). */
async function* readChunks(stream) {
    if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                yield value instanceof Uint8Array ? value : new Uint8Array(value);
            }
        } finally {
            reader.releaseLock();
        }
        return;
    }
    for await (const part of stream) yield part instanceof Uint8Array ? part : new Uint8Array(part);
}

/**
 * Seals a stream: the envelope comes out piece by piece, and only one chunk is ever in memory.
 * The size of the content has to be known, because the padded size is in the header and the
 * header is written first.
 */
function sealStream(stream, options = {}) {
    if (typeof options.size !== 'number' || options.size < 0) {
        fail('locker.invalid', 'A stream seal needs the size of the content');
    }
    const iterator = sealPieces(readChunks(stream), { ...options, size: options.size })[Symbol.asyncIterator]();
    return new ReadableStream({
        async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value.bytes);
        },
        async cancel(reason) { if (iterator.return) await iterator.return(reason); },
    });
}

/**
 * Opens a stream: the content comes out piece by piece, and only one chunk is ever in memory.
 *
 * The chunks are yielded as they are verified, so a reader sees the earlier ones before the last
 * one is reached. A stream that ends early throws at the end, when the missing chunk shows up:
 * discard what it yielded, because the content was never complete.
 */
function openStream(stream, credentials = {}) {
    const iterator = (async function* openStreamPieces() {
        const reader = streamReader(readChunks(stream)[Symbol.asyncIterator]());
        const head = await reader.probe(8);
        if (head === null) fail('locker.truncated', 'The envelope is too short to hold a header');
        if (fromUtf8(head.subarray(0, 4)) !== MAGIC) fail('locker.bad_envelope', 'These bytes are not a Locker envelope');
        const headerLength = readU32be(head, 4);
        if (headerLength === 0 || headerLength > 65536) {
            fail('locker.bad_envelope', `The envelope header is ${headerLength} bytes, which is not one we write`);
        }
        const headerBytes = await reader.take(headerLength);
        let header;
        try { header = JSON.parse(fromUtf8(headerBytes)); }
        catch { fail('locker.bad_envelope', 'The envelope header is not JSON'); }
        readCore(header);
        const contentKey = await openContentKey(header, credentials);
        const key = await importContentKey(contentKey, ['decrypt']);
        yield* openPieces(reader, header, key);
    })()[Symbol.asyncIterator]();
    return new ReadableStream({
        async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        async cancel(reason) { if (iterator.return) await iterator.return(reason); },
    });
}

/**
 * Wraps the content key for other people, without touching the content: the envelope's header
 * changes, the chunks do not, because the slots are not part of what the chunks authenticate.
 * This is how a member is added to a people-locked item: the people who are already on it keep
 * their slots, and the new ones get one of their own.
 *
 * Removing a member wants a fresh content key, not just a slot that is gone: the person who is
 * removed may still hold the old key. So a removal opens the content and seals it again, with a
 * new key and a new nonce base, for the people who are left. Their public keys are needed for
 * that, so the caller gives them in `keys`.
 */
async function rewrap(envelope, {
    add = [], remove = [], keys = [], credentials = {}, random = platformRandom, ephemeral,
} = {}) {
    const bytes = envelopeBytes(envelope);
    const { header, chunkOffset } = readHeader(bytes);
    if (header.lock !== 'people') fail('locker.invalid', 'Only a people-locked envelope can be re-wrapped');
    readCore(header);
    const gone = new Set(remove.map(who => (typeof who === 'string' ? who : who.id)));
    const staying = (header.slots.people || []).filter(slot => !gone.has(slot.subject.id));

    if (!gone.size) {
        // Adding: the content key and the chunks stay as they are.
        const contentKey = await openContentKey(header, credentials);
        const people = staying.slice();
        if (add.length) {
            const pair = await resolveEphemeral(ephemeral);
            for (const recipient of add) {
                people.push(await wrapFor(contentKey, recipient.publicKey, {
                    subject: recipient.subject, ephemeral: pair, random,
                }));
            }
        }
        if (!people.length) fail('locker.invalid', 'A people-locked envelope needs at least one slot');
        const newHeader = { ...coreOf(header), slots: { people } };
        const headerBytes = encodeHeader(newHeader);
        return {
            version: VERSION,
            header: newHeader,
            headerBytes,
            bytes: encodeEnvelope(headerBytes, bytes.subarray(chunkOffset)),
            chunkOffset: 8 + headerBytes.length,
        };
    }

    // Removing: the content is opened and sealed again under a new key, so the key the person
    // who is leaving still holds opens nothing.
    const contentKey = await openContentKey(header, credentials);
    const plain = await open(bytes, credentials);
    const recipients = [];
    for (const slot of staying) {
        const found = keys.find(key => (typeof key.subject === 'string' ? key.subject : key.subject.id) === slot.subject.id);
        if (!found) {
            fail('locker.invalid', `Removing a person needs the public key of ${slot.subject.id}, who stays`);
        }
        recipients.push({ subject: slot.subject, publicKey: found.publicKey });
    }
    for (const recipient of add) recipients.push({ subject: recipient.subject, publicKey: recipient.publicKey });
    if (!recipients.length) fail('locker.invalid', 'A people-locked envelope needs at least one slot');
    return seal(plain, { lock: 'people', keys: recipients, random, ephemeral });
}

module.exports = {
    seal, open, sealStream, openStream, rewrap,
    envelopeBytes, toBytes, openContentKey, readCore, prepare, makeHeader, Chunker,
    publicKeyOf, privateKeyOf, slotForPerson,
};
