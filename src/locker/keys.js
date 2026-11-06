'use strict';
/**
 * The keys: a person's two key pairs, the content key, and the two ways of wrapping the content
 * key for someone else (their public key, or a password).
 *
 * WebCrypto only: globalThis.crypto.subtle. No other crypto library, nothing hand-rolled: the
 * ECDH, the ECDSA, the HKDF, the PBKDF2 and the AES-GCM are all the browser's own.
 */
const { utf8, concat, base64, base64url, fromBase64, canonicalJson } = require('./bytes');
const { fail } = require('./errors');
const { WORDS } = require('./words');

/** The suite of the key pairs: P-256, which every browser's WebCrypto has. */
const CURVE = 'P-256';
/** How the content key is wrapped for a person. */
const PEOPLE_ALGORITHM = 'ECDH-P256/HKDF-SHA256/AES-256-GCM';
/** How the content key is wrapped for a password. */
const PASSWORD_ALGORITHM = 'PBKDF2-SHA256/AES-256-GCM';
/** The PBKDF2 floor for this version. The count may go up; it may not go down. */
const PASSWORD_ITERATIONS = 600000;
/** The smallest PBKDF2 count we accept, on both sides: the floor above. */
const PASSWORD_ITERATIONS_MIN = 600000;
/**
 * The largest PBKDF2 count we accept. The count comes from the header, so a hostile header could
 * ask for a derivation that takes hours; the ceiling keeps a browser honest.
 */
const PASSWORD_ITERATIONS_MAX = 10000000;
/** The content key is 32 bytes: AES-256. */
const KEY_BYTES = 32;
/** The salt of a people slot (HKDF) and of a password slot (PBKDF2). */
const SALT_BYTES = 16;

/** WebCrypto, or a clear error when the runtime has none. */
function subtle() {
    const crypto = globalThis.crypto;
    if (!crypto || !crypto.subtle) {
        fail('locker.no_crypto', 'This runtime has no WebCrypto (globalThis.crypto.subtle)');
    }
    return crypto.subtle;
}

/** Random bytes from the platform. */
function platformRandom(length) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
}

/** The SHA-256 of some bytes. */
async function sha256(bytes) {
    return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/** The bytes of a public JWK, as they go on the wire: no key_ops, no ext. */
function publicJwk(jwk) {
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** The message a person signs: both public keys, canonically. */
function fingerprintMessage(ecdhPublic, signingPublic) {
    return utf8(canonicalJson({ ecdh: publicJwk(ecdhPublic), signing: publicJwk(signingPublic) }));
}

/**
 * The eight words of a fingerprint: the first eight bytes of SHA-256, eight bits each, in two
 * groups of four. Sixty-four bits, not thirty-two: a server that swapped in its own key would
 * need about 2^32 key generations to land on the same four words, which is not "verify a
 * person"; with eight words it would need 2^64.
 *
 * The two groups are joined with a middle dot, not a hyphen: a hyphen reads as one compound
 * word ("plateau yew-apple petal"), and the groups are meant to be read apart.
 */
function fingerprintWords(hash) {
    const words = [];
    for (let i = 0; i < 8; i++) words.push(WORDS[hash[i]]);
    return `${words.slice(0, 4).join(' ')} · ${words.slice(4).join(' ')}`;
}

/**
 * The RFC 7638 thumbprint of a public JWK: SHA-256 over the canonical JSON of its four
 * required members, base64url. It names one key and nothing else, so a slot can be bound to
 * the key of the person it is for.
 */
async function jwkThumbprint(jwk) {
    const canonical = canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return base64url(await sha256(utf8(canonical)));
}

/** The fingerprint of a pair of public keys. */
async function fingerprintOf(ecdhPublic, signingPublic) {
    return fingerprintWords(await sha256(fingerprintMessage(ecdhPublic, signingPublic)));
}

/**
 * A person's two key pairs: an ECDH pair that receives content keys, and an ECDSA pair that signs
 * the fingerprint. The signing key signs both public keys, so the pair is self-certifying: a
 * reader can check that the holder owns the signing key, and the fingerprint changes whenever
 * either key changes.
 */
async function generatePersonKeys() {
    const s = subtle();
    const ecdh = await s.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
    const signing = await s.generateKey({ name: 'ECDSA', namedCurve: CURVE }, true, ['sign', 'verify']);
    const ecdhPublic = publicJwk(await s.exportKey('jwk', ecdh.publicKey));
    const signingPublic = publicJwk(await s.exportKey('jwk', signing.publicKey));
    const message = fingerprintMessage(ecdhPublic, signingPublic);
    const signature = new Uint8Array(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing.privateKey, message));
    return {
        ecdh: { publicKey: ecdh.publicKey, privateKey: ecdh.privateKey },
        signing: { publicKey: signing.publicKey, privateKey: signing.privateKey },
        ecdhPublic,
        signingPublic,
        fingerprint: fingerprintWords(await sha256(message)),
        fingerprintSignature: signature,
    };
}

/** The public half of a person's keys, as it is published: locker.public-keys@1. */
async function exportPersonKeys(person) {
    const ecdhPublic = publicJwk(person.ecdhPublic || await subtle().exportKey('jwk', person.ecdh.publicKey));
    const signingPublic = publicJwk(person.signingPublic || await subtle().exportKey('jwk', person.signing.publicKey));
    const message = fingerprintMessage(ecdhPublic, signingPublic);
    const signature = person.fingerprintSignature
        || new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, person.signing.privateKey, message));
    return {
        ecdh: ecdhPublic,
        signing: signingPublic,
        fingerprint: fingerprintWords(await sha256(message)),
        fingerprint_signature: base64(signature),
    };
}

/**
 * The private half of a person's keys, as it is stored: the two private keys as JWKs.
 */
async function exportPrivateKeys(person) {
    const ecdh = await subtle().exportKey('jwk', person.ecdh.privateKey);
    const signing = await subtle().exportKey('jwk', person.signing.privateKey);
    return { ecdh, signing };
}

/**
 * A person's keys, ready to use: the private keys as CryptoKeys and the public keys as JWKs.
 * The private keys may be JWKs (as they are stored) or CryptoKeys (as they are in memory).
 */
async function importPersonKeys(data) {
    const s = subtle();
    const ecdhPrivate = data.ecdhPrivateKey
        || await s.importKey('jwk', data.ecdh, { name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
    const signingPrivate = data.signingPrivateKey
        || await s.importKey('jwk', data.signing, { name: 'ECDSA', namedCurve: CURVE }, true, ['sign']);
    return {
        ecdhPrivateKey: ecdhPrivate,
        signingPrivateKey: signingPrivate,
        ecdhPublic: data.ecdh ? publicJwk(data.ecdh) : publicJwk(await s.exportKey('jwk', ecdhPrivate)),
        signingPublic: data.signing ? publicJwk(data.signing) : publicJwk(await s.exportKey('jwk', signingPrivate)),
    };
}

/**
 * Checks a published set of keys: the signature must verify with the signing key, and the four
 * words must be the fingerprint of the two keys. Returns false instead of throwing, so a caller
 * can show a warning rather than an error.
 */
async function verifyPersonKeys(data) {
    try {
        const s = subtle();
        const message = fingerprintMessage(data.ecdh, data.signing);
        const signature = fromBase64(data.fingerprint_signature);
        const key = await s.importKey('jwk', data.signing, { name: 'ECDSA', namedCurve: CURVE }, true, ['verify']);
        const ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
        if (!ok) return false;
        return fingerprintWords(await sha256(message)) === data.fingerprint;
    } catch {
        return false;
    }
}

/** The content key as an AES-GCM CryptoKey. */
async function importContentKey(bytes, usages) {
    if (!bytes || bytes.length !== KEY_BYTES) fail('locker.invalid', 'The content key is 32 bytes');
    return subtle().importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** The wrapping key for a person: the ECDH secret, put through HKDF-SHA-256. */
async function deriveWrappingKey(sharedSecret, salt, info) {
    const s = subtle();
    const material = await s.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    return s.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** The wrapping key for a password: PBKDF2-SHA-256, with the parameters the header names. */
async function derivePasswordKey(password, salt, iterations) {
    if (typeof password !== 'string' || !password.length) fail('locker.invalid', 'A password lock needs a password');
    // The count comes from the header, so it is checked before it is used: a hostile header must
    // not be able to make a reader spend minutes (or hours) on the derivation.
    if (!Number.isInteger(iterations) || iterations < PASSWORD_ITERATIONS_MIN || iterations > PASSWORD_ITERATIONS_MAX) {
        fail('locker.bad_envelope', `The iteration count is not between ${PASSWORD_ITERATIONS_MIN} and ${PASSWORD_ITERATIONS_MAX}`);
    }
    const s = subtle();
    const material = await s.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * The associated data of a people slot: it binds the slot to one person, to that person's key
 * and to one envelope.
 */
function peopleSlotAad(subject, ephemeralPublic, salt, recipientKey) {
    const id = typeof subject === 'string' ? subject : `${subject.type}:${subject.id}`;
    return utf8(`openvibe-locker people-slot v1|${id}|${recipientKey}|${canonicalJson(publicJwk(ephemeralPublic))}|${base64(salt)}`);
}

/** The associated data of a password slot: it binds the slot to its own parameters. */
function passwordSlotAad(iterations, salt) {
    return utf8(`openvibe-locker password-slot v1|${iterations}|${base64(salt)}`);
}

/** A public key as WebCrypto wants it. */
async function importPublicKey(jwk) {
    try {
        return await subtle().importKey('jwk', publicJwk(jwk), { name: 'ECDH', namedCurve: CURVE }, true, []);
    } catch {
        fail('locker.invalid', 'The public key is not a P-256 key');
    }
}

/**
 * The envelope's one ephemeral ECDH key pair. It may be given (the shared test vectors need the
 * same bytes every time), or made fresh.
 */
async function resolveEphemeral(ephemeral) {
    const s = subtle();
    if (!ephemeral) {
        const pair = await s.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
        return { privateKey: pair.privateKey, publicKey: pair.publicKey };
    }
    if (ephemeral.privateKey) return ephemeral;
    const privateKey = await s.importKey('jwk', ephemeral.private, { name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
    return { privateKey };
}

/**
 * Wraps the content key for one person: the content key, sealed for their public key.
 * The envelope has one ephemeral ECDH key pair; the shared secret with each person goes through
 * HKDF-SHA-256, and the slot's tag covers the person, their key, the ephemeral key and the
 * salt, so a slot cannot be moved to another person or replayed from another envelope.
 */
async function wrapFor(contentKey, publicKey, { subject, salt, random = platformRandom, ephemeral } = {}) {
    const s = subtle();
    if (!subject) fail('locker.invalid', 'A people slot needs the subject it is for');
    const theirs = await importPublicKey(publicKey);
    const pair = await resolveEphemeral(ephemeral);
    const ephemeralPublic = publicJwk(await s.exportKey('jwk', pair.publicKey || pair.privateKey));
    // The slot names the key it is for, so an opener can check it before deriving anything.
    const recipientKey = await jwkThumbprint(publicJwk(publicKey));
    const shared = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
    const slotSalt = salt || random(SALT_BYTES);
    const key = await deriveWrappingKey(shared, slotSalt, utf8(`openvibe-locker people-slot v1|${subject.type}:${subject.id}|${recipientKey}`));
    const nonce = random(12);
    const sealed = new Uint8Array(await s.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: peopleSlotAad(subject, ephemeralPublic, slotSalt, recipientKey) },
        key,
        contentKey,
    ));
    return {
        subject,
        algorithm: PEOPLE_ALGORITHM,
        recipient_key: recipientKey,
        ephemeral_public_key: ephemeralPublic,
        salt: base64(slotSalt),
        nonce: base64(nonce),
        wrapped_key: base64(sealed),
    };
}

/** The content key out of a people slot: the recipient's private key and the slot. */
async function unwrapPeopleSlot(slot, privateKey) {
    const s = subtle();
    // The slot names the key it was made for. If it is not this key, the slot is not this
    // person's, and nothing is derived: the check comes before the work.
    if (!slot.recipient_key) fail('locker.bad_envelope', 'The slot does not name the key it is for');
    const theirPublic = publicJwk(await s.exportKey('jwk', privateKey));
    const recipientKey = await jwkThumbprint(theirPublic);
    if (slot.recipient_key !== recipientKey) {
        fail('locker.wrong_key', 'This slot is for another key');
    }
    const theirs = await s.importKey('jwk', publicJwk(slot.ephemeral_public_key), { name: 'ECDH', namedCurve: CURVE }, true, []);
    const shared = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256));
    const salt = fromBase64(slot.salt);
    const key = await deriveWrappingKey(shared, salt, utf8(`openvibe-locker people-slot v1|${slot.subject.type}:${slot.subject.id}|${recipientKey}`));
    try {
        const plain = new Uint8Array(await s.decrypt(
            { name: 'AES-GCM', iv: fromBase64(slot.nonce), additionalData: peopleSlotAad(slot.subject, slot.ephemeral_public_key, salt, recipientKey) },
            key,
            fromBase64(slot.wrapped_key),
        ));
        if (plain.length !== KEY_BYTES) fail('locker.wrong_key', 'The slot does not hold a content key');
        return plain;
    } catch (err) {
        if (err && err.code) throw err;
        fail('locker.wrong_key', 'This key does not open that slot');
    }
}

/** Wraps the content key with a password: PBKDF2-SHA-256, then AES-256-GCM. */
async function wrapForPassword(contentKey, password, { salt, iterations = PASSWORD_ITERATIONS, random = platformRandom } = {}) {
    const s = subtle();
    const slotSalt = salt || random(SALT_BYTES);
    const key = await derivePasswordKey(password, slotSalt, iterations);
    const nonce = random(12);
    const sealed = new Uint8Array(await s.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: passwordSlotAad(iterations, slotSalt) },
        key,
        contentKey,
    ));
    return {
        algorithm: PASSWORD_ALGORITHM,
        kdf: 'PBKDF2-SHA-256',
        iterations,
        salt: base64(slotSalt),
        nonce: base64(nonce),
        wrapped_key: base64(sealed),
    };
}

/** The content key out of a password slot. The parameters come from the slot, never from here. */
async function unwrapPasswordSlot(slot, password) {
    const s = subtle();
    const salt = fromBase64(slot.salt);
    const key = await derivePasswordKey(password, salt, slot.iterations);
    try {
        const plain = new Uint8Array(await s.decrypt(
            { name: 'AES-GCM', iv: fromBase64(slot.nonce), additionalData: passwordSlotAad(slot.iterations, salt) },
            key,
            fromBase64(slot.wrapped_key),
        ));
        if (plain.length !== KEY_BYTES) fail('locker.wrong_key', 'The slot does not hold a content key');
        return plain;
    } catch (err) {
        if (err && err.code) throw err;
        fail('locker.wrong_key', 'That password does not open this item');
    }
}

module.exports = {
    CURVE, PEOPLE_ALGORITHM, PASSWORD_ALGORITHM, PASSWORD_ITERATIONS,
    PASSWORD_ITERATIONS_MIN, PASSWORD_ITERATIONS_MAX, KEY_BYTES, SALT_BYTES,
    subtle, platformRandom, sha256, publicJwk, fingerprintMessage, fingerprintWords, fingerprintOf,
    jwkThumbprint, generatePersonKeys, exportPersonKeys, exportPrivateKeys, importPersonKeys,
    verifyPersonKeys, importContentKey, deriveWrappingKey, derivePasswordKey, resolveEphemeral,
    peopleSlotAad, passwordSlotAad, wrapFor, unwrapPeopleSlot, wrapForPassword, unwrapPasswordSlot,
};
