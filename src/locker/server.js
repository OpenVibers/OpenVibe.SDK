'use strict';
/**
 * What a service needs to know about an envelope without opening it: the header's shape and the
 * envelope's size. Nothing here decrypts anything, and nothing here needs a key: a service may
 * hold the bytes of an item it can never read.
 *
 * A service that stores an envelope should:
 *   - check it with inspectEnvelope() and refuse what does not pass;
 *   - keep the header as it is (it holds no key material, only wrapped keys);
 *   - skip indexing, previews, thumbnails, transcoding and content AI;
 *   - show the lock badge, and serve the bytes only to the people canView allows.
 */
const { fromUtf8, fromBase64, readU32be } = require('./bytes');
const {
    MAGIC, VERSION, SUITE, CHUNK_SIZE, TAG_SIZE, NONCE_SIZE, NONCE_BASE_SIZE, MIN_PADDED_SIZE,
    MAX_HEADER_BYTES, chunkCount, lastChunkSize,
} = require('./format');

/** The bytes of a base64 field, or null when it is not base64 of that many bytes. */
function bytesOf(text, length) {
    if (typeof text !== 'string' || !text.length) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
    let bytes;
    try { bytes = fromBase64(text); } catch { return null; }
    return bytes.length === length ? bytes : null;
}

/** A subject: { type, id }, both there. */
function subjectOk(subject) {
    return !!subject && typeof subject === 'object' && typeof subject.type === 'string'
        && typeof subject.id === 'string' && subject.type.length > 0 && subject.id.length > 0;
}

/** A public key as a JWK: P-256, with its two coordinates. */
function publicKeyOk(key) {
    return !!key && typeof key === 'object' && key.kty === 'EC' && key.crv === 'P-256'
        && typeof key.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x)
        && typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.y);
}

/** One people slot: whose it is, which key it is for, and the wrapped key with the bytes it must have. */
function peopleSlotOk(slot) {
    if (!slot || typeof slot !== 'object') return false;
    if (!subjectOk(slot.subject)) return false;
    if (slot.algorithm !== 'ECDH-P256/HKDF-SHA256/AES-256-GCM') return false;
    // The thumbprint of the recipient's key: the slot names the key it is for.
    if (typeof slot.recipient_key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(slot.recipient_key)) return false;
    if (!publicKeyOk(slot.ephemeral_public_key)) return false;
    if (!bytesOf(slot.salt, 16)) return false;
    if (!bytesOf(slot.nonce, NONCE_SIZE)) return false;
    return !!bytesOf(slot.wrapped_key, 48);
}

/** The password slot: the parameters and the wrapped key. */
function passwordSlotOk(slot) {
    if (!slot || typeof slot !== 'object') return false;
    if (slot.algorithm !== 'PBKDF2-SHA256/AES-256-GCM') return false;
    if (slot.kdf !== 'PBKDF2-SHA-256') return false;
    if (!Number.isInteger(slot.iterations) || slot.iterations < 600000 || slot.iterations > 10000000) return false;
    if (!bytesOf(slot.salt, 16)) return false;
    if (!bytesOf(slot.nonce, NONCE_SIZE)) return false;
    return !!bytesOf(slot.wrapped_key, 48);
}

/**
 * The header's shape: what it says, and whether the slots match the lock it names. The problems
 * are returned as words, so a service can log them; nothing is thrown and nothing is decrypted.
 */
function checkHeader(header) {
    const errors = [];
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
        return ['the header is not an object'];
    }
    if (header.version !== VERSION) errors.push(`the version is not ${VERSION}`);
    if (header.suite !== SUITE) errors.push(`the suite is not ${SUITE}`);
    if (header.chunk_size !== CHUNK_SIZE) errors.push(`the chunk size is not ${CHUNK_SIZE}`);
    if (!Number.isInteger(header.padded_size) || header.padded_size < MIN_PADDED_SIZE) {
        errors.push(`the padded size is not at least ${MIN_PADDED_SIZE} bytes`);
    }
    if (!bytesOf(header.nonce_base, NONCE_BASE_SIZE)) errors.push('the nonce base is not eight bytes');
    if (!['people', 'password', 'link'].includes(header.lock)) errors.push('the lock is not one we know');
    const slots = header.slots;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
        errors.push('the header has no slots');
        return errors;
    }
    const kinds = Object.keys(slots);
    const wanted = header.lock === 'people' ? 'people' : header.lock;
    if (kinds.length !== 1 || kinds[0] !== wanted) {
        errors.push(`the slots do not match the ${header.lock} lock`);
        return errors;
    }
    if (wanted === 'people') {
        if (!Array.isArray(slots.people) || !slots.people.length || slots.people.length > 100) {
            errors.push('the people slots are not a list of one to a hundred');
        } else if (!slots.people.every(peopleSlotOk)) {
            errors.push('a people slot is not the shape it must be');
        }
    } else if (wanted === 'password') {
        if (!passwordSlotOk(slots.password)) errors.push('the password slot is not the shape it must be');
    } else if (Object.keys(slots.link).length) {
        errors.push('a link slot stores nothing, and this one does');
    }
    return errors;
}

/**
 * Reads an envelope's header and checks its shape and its size. Nothing is decrypted and no key
 * is needed: this is what a service runs on bytes it may never be able to read.
 */
function inspectEnvelope(bytes, { maxHeaderBytes = MAX_HEADER_BYTES } = {}) {
    const errors = [];
    const data = bytes instanceof Uint8Array ? bytes : null;
    if (!data) return { valid: false, errors: ['the envelope is not bytes'], header: null };
    if (data.length < 8) return { valid: false, errors: ['the envelope is too short to hold a header'], header: null };
    if (fromUtf8(data.subarray(0, 4)) !== MAGIC) {
        return { valid: false, errors: ['these bytes are not a Locker envelope'], header: null };
    }
    const headerLength = readU32be(data, 4);
    if (headerLength === 0 || headerLength > maxHeaderBytes) {
        return { valid: false, errors: [`the envelope header is ${headerLength} bytes, which is not one we write`], header: null };
    }
    if (data.length < 8 + headerLength) {
        return { valid: false, errors: ['the envelope ends inside its header'], header: null };
    }
    let header = null;
    try { header = JSON.parse(fromUtf8(data.subarray(8, 8 + headerLength))); }
    catch { return { valid: false, errors: ['the envelope header is not JSON'], header: null }; }
    errors.push(...checkHeader(header));
    const chunkOffset = 8 + headerLength;
    let expectedBytes = null;
    if (Number.isInteger(header.padded_size) && header.padded_size >= MIN_PADDED_SIZE
        && header.chunk_size === CHUNK_SIZE) {
        const chunks = chunkCount(header.padded_size);
        // Every chunk: its length, its flags, its nonce, the ciphertext and the tag. Every chunk
        // but the last is a whole chunk; the last holds what is left of the padded size.
        const frame = 4 + 1 + NONCE_SIZE;
        const whole = (chunks - 1) * (frame + CHUNK_SIZE + TAG_SIZE);
        const last = frame + lastChunkSize(header.padded_size) + TAG_SIZE;
        expectedBytes = chunkOffset + whole + last;
        if (data.length < expectedBytes) errors.push('the envelope is shorter than its own header says');
    }
    return {
        valid: errors.length === 0,
        errors,
        header,
        headerLength,
        chunkOffset,
        lock: header.lock,
        paddedSize: header.padded_size,
        chunkCount: Number.isInteger(header.padded_size) ? chunkCount(header.padded_size) : null,
        expectedBytes,
    };
}

module.exports = { inspectEnvelope, checkHeader, peopleSlotOk };
