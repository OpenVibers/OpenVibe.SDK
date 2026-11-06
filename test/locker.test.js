'use strict';
/**
 * Locker: the format, the three locks, the streams, the keys and the tampering.
 *
 * The point of these tests is that a sealed item opens with the right key and only with it: a
 * header that was changed, a chunk that was changed, chunks in the wrong order, a missing last
 * chunk and the wrong key all have to fail, and none of them may leak the content.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('./helpers');
const locker = require('../src/locker');
const server = require('../src/locker/server');
const vectors = require('../src/locker/vectors');
const contracts = require('openvibe-contracts');

const CHUNK = locker.CHUNK_SIZE;
const A = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
const B = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR' };
const decoder = new TextDecoder();
const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/** The bytes of a string, without Buffer (the library is browser-safe). */
const text = (value) => new TextEncoder().encode(value);

/** base64url without padding, for the thumbprints. */
const base64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A person with keys, made once for the whole file. */
let alice = null;
let bob = null;

/** Seals for the people lock, with the two people in it. */
const sealFor = (content, options = {}) => locker.seal(content, {
    lock: 'people',
    keys: [{ subject: A, publicKey: alice.ecdhPublic }, { subject: B, publicKey: bob.ecdhPublic }],
    ...options,
});

/** The bytes of one chunk frame, and where the next one starts. */
function frames(bytes, offset) {
    const out = [];
    let at = offset;
    while (at < bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
        out.push({ start: at, length: length + 17, end: at + length + 17 });
        at += length + 17;
    }
    return out;
}

const fails = async (fn, code) => {
    await assert.rejects(fn, (err) => {
        assert.ok(err instanceof locker.LockerError, `expected a LockerError, got ${err && err.name}`);
        if (code) assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
        return true;
    });
};

/** The envelope bytes with a changed header: the header is written again and its length fixed. */
function withHeader(envelope, change) {
    const headerBytes = text(JSON.stringify(change(envelope.header)));
    const out = new Uint8Array(8 + headerBytes.length + envelope.bytes.length - envelope.chunkOffset);
    out.set(text('OVLK'), 0);
    new DataView(out.buffer).setUint32(4, headerBytes.length, false);
    out.set(headerBytes, 8);
    out.set(envelope.bytes.subarray(envelope.chunkOffset), 8 + headerBytes.length);
    return out;
}

/** Decrypts the first chunk of an envelope with a content key: does that key open it? */
async function decryptFirstChunk(envelope, contentKey) {
    const subtle = globalThis.crypto.subtle;
    const { header, bytes, chunkOffset } = envelope;
    const length = new DataView(bytes.buffer, bytes.byteOffset + chunkOffset, 4).getUint32(0, false);
    const flags = bytes[chunkOffset + 4];
    const nonce = bytes.subarray(chunkOffset + 5, chunkOffset + 17);
    const ciphertext = bytes.subarray(chunkOffset + 17, chunkOffset + 17 + length);
    // The associated data: the core in canonical JSON, the counter and the flags.
    const core = {
        chunk_size: header.chunk_size, lock: header.lock, nonce_base: header.nonce_base,
        padded_size: header.padded_size, suite: header.suite, version: header.version,
    };
    const aad = text(JSON.stringify(core));
    const full = new Uint8Array(aad.length + 5);
    full.set(aad, 0);
    new DataView(full.buffer).setUint32(aad.length, 0, false);
    full[aad.length + 4] = flags;
    const key = await subtle.importKey('raw', contentKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: full }, key, ciphertext));
}

run([
    ['a person has two key pairs and eight words', async () => {
        alice = await locker.generatePersonKeys();
        bob = await locker.generatePersonKeys();
        assert.equal(alice.ecdhPublic.kty, 'EC');
        assert.equal(alice.ecdhPublic.crv, 'P-256');
        assert.equal(alice.signingPublic.kty, 'EC');
        // Eight words in two groups of four, joined by a middle dot: sixty-four bits.
        assert.match(alice.fingerprint, /^[a-z]+ [a-z]+ [a-z]+ [a-z]+ · [a-z]+ [a-z]+ [a-z]+ [a-z]+$/);
        assert.equal(alice.fingerprint.split(' · ').length, 2);
        assert.equal(alice.fingerprint.split(' · ')[0].split(' ').length, 4);
        assert.notEqual(alice.fingerprint, bob.fingerprint);
        const published = await locker.exportPersonKeys(alice);
        assert.equal(published.fingerprint, alice.fingerprint);
        assert.equal(await locker.verifyPersonKeys(published), true);
        // And the published keys are the contract.
        const checked = contracts.validate('locker.public-keys', {
            subject: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' },
            ecdh: published.ecdh,
            signing: published.signing,
            fingerprint: published.fingerprint,
            fingerprint_signature: published.fingerprint_signature,
            updated_at: '2026-11-06T00:00:00Z',
        });
        assert.equal(checked.valid, true, JSON.stringify(checked.errors));
        // A fingerprint that does not belong to the keys is caught.
        assert.equal(await locker.verifyPersonKeys({ ...published, fingerprint: 'wrong words here now · bad bad bad bad' }), false);
        // A signature over other keys is caught.
        const other = await locker.exportPersonKeys(bob);
        assert.equal(await locker.verifyPersonKeys({ ...published, fingerprint_signature: other.fingerprint_signature }), false);
    }],

    ['a recovery phrase is words from the list', async () => {
        assert.equal(locker.WORDS.length, 256);
        assert.equal(locker.RECOVERY_WORDS, 24);
        const phrase = locker.recoveryWords();
        const words = phrase.split(' ');
        assert.equal(words.length, 24, 'the phrase has 24 words');
        for (const word of words) assert.ok(locker.WORDS.includes(word), `${word} is one of the 256`);
        // Two phrases are never the same: the words come from the platform's CSPRNG.
        assert.notEqual(phrase, locker.recoveryWords());
        assert.notEqual(phrase.split(' ')[0], locker.recoveryWords().split(' ')[0]);
        // Another number of words, and the same check on a typed phrase.
        assert.equal(locker.recoveryWords(12).split(' ').length, 12);
        assert.equal(locker.isRecoveryPhrase(phrase), true);
        assert.equal(locker.isRecoveryPhrase('  amber   anchor  '), true, 'the spacing does not matter');
        assert.equal(locker.isRecoveryPhrase('amber anchor harbor zzzz'), false, 'a word that is not in the list');
        assert.equal(locker.isRecoveryPhrase(''), false);
        assert.equal(locker.isRecoveryPhrase('AMBER ANCHOR'), true, 'the list is lower case');
        // The words come from the CSPRNG, not from a fixed source: the platform's bytes.
        assert.throws(() => locker.recoveryWords(0), (err) => err.code === 'locker.invalid');
        assert.throws(() => locker.recoveryWords(257), (err) => err.code === 'locker.invalid');
    }],

    ['a people lock opens by key, without a subject', async () => {
        const sealed = await sealFor('a note');
        // The reader knows their own key and nothing else.
        const opened = await locker.open(sealed.bytes, { person: alice });
        assert.equal(decoder.decode(opened), 'a note');
        // The other person on the list opens it with their own key.
        assert.equal(decoder.decode(await locker.open(sealed.bytes, { person: bob })), 'a note');
        // A key that is not on the list: there is no slot for it, which is not a wrong key.
        const stranger = await locker.generatePersonKeys();
        await fails(() => locker.open(sealed.bytes, { person: stranger }), 'locker.no_slot');
        // A person with no private key cannot open it either.
        await fails(() => locker.open(sealed.bytes, { person: { ecdhPublic: alice.ecdhPublic } }), 'locker.no_key');
    }],

    ['inspect says what an envelope is, without a key', async () => {
        const people = await sealFor('a note');
        const seen = locker.inspect(people.bytes);
        assert.equal(seen.version, 'locker.envelope.v1');
        assert.equal(seen.lock, 'people');
        assert.equal(seen.padded_size, people.header.padded_size);
        assert.equal(seen.recipients.length, 2);
        assert.equal(seen.recipients[0], people.header.slots.people[0].recipient_key);
        assert.equal(seen.recipients[1], people.header.slots.people[1].recipient_key);
        assert.equal(seen.iterations, null);
        // A password lock names its iteration count.
        const password = await locker.seal('a note', { lock: 'password', password: 'x', iterations: 700000 });
        const seenPassword = locker.inspect(password.bytes);
        assert.equal(seenPassword.lock, 'password');
        assert.equal(seenPassword.iterations, 700000);
        assert.deepEqual(seenPassword.recipients, []);
        // A link lock says nothing about anybody.
        const link = await locker.seal('a note', { lock: 'link' });
        assert.deepEqual(locker.inspect(link.bytes).recipients, []);
        assert.equal(locker.inspect(link.bytes).iterations, null);
        // Bytes that are not an envelope at all. (inspect is synchronous, so it throws.)
        assert.throws(() => locker.inspect(text('not an envelope')), (err) => err.code === 'locker.bad_envelope');
    }],

    ['the three locks round trip', async () => {
        const note = 'a note for @maticus';
        const people = await sealFor(note);
        assert.equal(decoder.decode(await locker.open(people, { privateKey: alice.ecdh.privateKey, subject: A })), note);
        assert.equal(decoder.decode(await locker.open(people, { privateKey: bob.ecdh.privateKey, subject: B })), note);
        const password = await locker.seal(note, { lock: 'password', password: 'correct horse battery staple' });
        assert.equal(decoder.decode(await locker.open(password, { password: 'correct horse battery staple' })), note);
        const link = await locker.seal(note, { lock: 'link' });
        assert.deepEqual(link.header.slots.link, {});
        assert.equal(decoder.decode(await locker.open(link, { key: link.linkKey })), note);
        // The link key is in the link, not in the envelope.
        assert.equal(JSON.stringify(link.header).includes(link.linkKey), false);
    }],

    ['every size around the chunk boundary round trips', async () => {
        for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 7]) {
            const content = new Uint8Array(size);
            for (let i = 0; i < size; i++) content[i] = (i * 7 + 13) % 251;
            const sealed = await locker.seal(content, { lock: 'password', password: 'x' });
            assert.ok(sealed.header.padded_size >= size, 'the padded size covers the content');
            const opened = await locker.open(sealed, { password: 'x' });
            assert.equal(opened.length, size, `the content comes back whole (${size})`);
            assert.equal(sha256(opened), sha256(content), `the content is the same (${size})`);
        }
    }],

    ['the padded size is Padmé\'s, and it hides the real size', async () => {
        const sizes = [0, 1, 247, 248, 249, CHUNK - 9, CHUNK - 8, CHUNK, CHUNK + 1, 5 * 1024 * 1024 + 3];
        for (const size of sizes) {
            const content = new Uint8Array(size);
            for (let i = 0; i < size; i++) content[i] = (i * 11 + 3) % 251;
            const sealed = await locker.seal(content, { lock: 'password', password: 'x' });
            const padded = sealed.header.padded_size;
            // The padded size is the length prefix and the content, padded with Padmé.
            assert.equal(padded, Math.max(256, locker.padme(size + 8)), `the padded size (${size})`);
            assert.ok(padded >= size + 8, 'the padded size covers the length prefix and the content');
            // Padmé's expansion stays under twelve per cent.
            const expansion = (locker.padme(size + 8) - (size + 8)) / (size + 8);
            assert.ok(expansion <= 0.12, `the padding of ${size} bytes is ${(expansion * 100).toFixed(2)}%`);
            // Every chunk but the last is a whole chunk; the last holds the rest. (A frame is
            // its length, its flags and its nonce, then the ciphertext with the tag.)
            const list = frames(sealed.bytes, sealed.chunkOffset);
            assert.equal(list.length, Math.ceil(padded / CHUNK), `the number of chunks (${size})`);
            for (const frame of list.slice(0, -1)) assert.equal(frame.length - 17 - 16, CHUNK, 'a whole chunk');
            assert.equal(
                list[list.length - 1].length - 17 - 16,
                padded - (list.length - 1) * CHUNK,
                'the last chunk holds the rest',
            );
            // The content comes back whole.
            const opened = await locker.open(sealed, { password: 'x' });
            assert.equal(opened.length, size, `the content comes back whole (${size})`);
            assert.equal(sha256(opened), sha256(content), `the content is the same (${size})`);
        }
        // And the expansion never goes over twelve per cent, over a wide range of sizes.
        let worst = 0;
        for (let n = 2; n <= 200000; n++) worst = Math.max(worst, (locker.padme(n) - n) / n);
        assert.ok(worst <= 0.12, `the worst padding is ${(worst * 100).toFixed(2)}%`);
        // The arithmetic is exact above 2^31: no 32-bit bitwise operators.
        assert.equal(locker.padme(2 ** 31 + 1), 2 ** 31 + 2 ** 26);
        assert.equal(locker.padme(2 ** 40), 2 ** 40);
        assert.equal(locker.padme(3 * 2 ** 40), 3 * 2 ** 40);
    }],

    ['the server sees the padded size, not the size', async () => {
        const sealed = await locker.seal('short', { lock: 'password', password: 'x' });
        assert.equal(sealed.header.padded_size, 256);
        assert.ok(!JSON.stringify(sealed.header).includes('short'));
    }],

    ['a header that was changed fails', async () => {
        const sealed = await sealFor('a note');
        const bytes = sealed.bytes.slice();
        // Change the lock kind in the header: the chunks authenticate the core.
        const headerText = decoder.decode(bytes.subarray(8, sealed.chunkOffset));
        const changed = headerText.replace('"lock":"people"', '"lock":"link"');
        assert.notEqual(changed, headerText);
        bytes.set(text(changed), 8);
        await fails(() => locker.open(bytes, { privateKey: alice.ecdh.privateKey, subject: A }));
    }],

    ['a chunk that was changed fails', async () => {
        const sealed = await sealFor('a note');
        const bytes = sealed.bytes.slice();
        const [first] = frames(bytes, sealed.chunkOffset);
        bytes[first.start + 20] ^= 0x01;      // one bit of the ciphertext
        await fails(() => locker.open(bytes, { privateKey: alice.ecdh.privateKey, subject: A }));
    }],

    ['chunks in the wrong order fail', async () => {
        const content = new Uint8Array(CHUNK * 2 + 5);
        const sealed = await locker.seal(content, { lock: 'password', password: 'x' });
        const bytes = sealed.bytes.slice();
        const list = frames(bytes, sealed.chunkOffset);
        assert.equal(list.length, 3);
        // Swap the first two chunks.
        const first = bytes.slice(list[0].start, list[0].end);
        const second = bytes.slice(list[1].start, list[1].end);
        bytes.set(second, list[0].start);
        bytes.set(first, list[1].start);
        await fails(() => locker.open(bytes, { password: 'x' }));
    }],

    ['a chunk that claims to be huge is refused', async () => {
        const sealed = await sealFor('a note');
        const bytes = sealed.bytes.slice();
        // The length of the first chunk, in the frame: a lie the reader must not wait for.
        const at = sealed.chunkOffset;
        new DataView(bytes.buffer, bytes.byteOffset + at, 4).setUint32(0, 0xffffffff, false);
        await fails(() => locker.open(bytes, { privateKey: alice.ecdh.privateKey, subject: A }), 'locker.bad_envelope');
    }],

    ['a missing last chunk fails', async () => {
        const content = new Uint8Array(CHUNK * 2 + 5);
        const sealed = await locker.seal(content, { lock: 'password', password: 'x' });
        const bytes = sealed.bytes.slice();
        const list = frames(bytes, sealed.chunkOffset);
        await fails(() => locker.open(bytes.subarray(0, list[list.length - 1].start), { password: 'x' }), 'locker.truncated');
    }],

    ['a cut envelope fails', async () => {
        const sealed = await sealFor('a note');
        await fails(() => locker.open(sealed.bytes.subarray(0, 20), { privateKey: alice.ecdh.privateKey, subject: A }));
        await fails(() => locker.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { password: 'x' }));
    }],

    ['the wrong key fails', async () => {
        const password = await locker.seal('a note', { lock: 'password', password: 'right' });
        await fails(() => locker.open(password, { password: 'wrong' }), 'locker.wrong_key');
        await fails(() => locker.open(password, {}), 'locker.no_key');
        const people = await sealFor('a note');
        const stranger = await locker.generatePersonKeys();
        await fails(() => locker.open(people, { privateKey: stranger.ecdh.privateKey, subject: A }), 'locker.wrong_key');
        // Alice's key does not open Bob's slot.
        await fails(() => locker.open(people, { privateKey: alice.ecdh.privateKey, subject: B }), 'locker.wrong_key');
        // And there is no slot for someone who is not on the list.
        await fails(() => locker.open(people, {
            privateKey: alice.ecdh.privateKey,
            subject: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS' },
        }), 'locker.no_key');
        const link = await locker.seal('a note', { lock: 'link' });
        await fails(() => locker.open(link, { key: new Uint8Array(32) }), 'locker.wrong_key');
    }],

    ['the password parameters come from the header', async () => {
        const sealed = await locker.seal('a note', { lock: 'password', password: 'right', iterations: 700000 });
        assert.equal(sealed.header.slots.password.iterations, 700000);
        assert.equal(sealed.header.slots.password.kdf, 'PBKDF2-SHA-256');
        assert.equal(sealed.header.slots.password.salt.length, 24);
        // The open takes the salt and the count from the header, not from its own defaults.
        assert.equal(decoder.decode(await locker.open(sealed, { password: 'right' })), 'a note');
        // Weakening them in the header does not open the item: the tag covers them.
        const bytes = sealed.bytes.slice();
        const headerText = decoder.decode(bytes.subarray(8, sealed.chunkOffset));
        bytes.set(text(headerText.replace('700000', '600000')), 8);
        await fails(() => locker.open(bytes, { password: 'right' }), 'locker.wrong_key');
    }],

    ['the iteration count is bounded on both sides', async () => {
        const sealed = await locker.seal('a note', { lock: 'password', password: 'right', iterations: 700000 });
        // A hostile header must not be able to make a reader spend minutes on the derivation.
        for (const iterations of [0, 1, 599999, 10000001, 1000000000]) {
            const bytes = withHeader(sealed, (header) => ({
                ...header,
                slots: { password: { ...header.slots.password, iterations } },
            }));
            await fails(() => locker.open(bytes, { password: 'right' }), 'locker.bad_envelope');
        }
        // And the writer refuses a count outside the range too.
        await fails(() => locker.seal('a note', { lock: 'password', password: 'right', iterations: 599999 }), 'locker.bad_envelope');
        await fails(() => locker.seal('a note', { lock: 'password', password: 'right', iterations: 10000001 }), 'locker.bad_envelope');
        // The bounds are the ones the contract names.
        assert.equal(locker.PASSWORD_ITERATIONS_MIN, 600000);
        assert.equal(locker.PASSWORD_ITERATIONS_MAX, 10000000);
        assert.equal(locker.PASSWORD_ITERATIONS, 600000);
        // A count inside the range is fine.
        const fine = await locker.seal('a note', { lock: 'password', password: 'right', iterations: 10000000 });
        assert.equal(decoder.decode(await locker.open(fine, { password: 'right' })), 'a note');
    }],

    ['a people slot is bound to the key of its recipient', async () => {
        const sealed = await sealFor('a note');
        const slot = sealed.header.slots.people[0];
        // The slot names the key it is for, by the RFC 7638 thumbprint of that key.
        const canonical = `{"crv":"P-256","kty":"EC","x":"${alice.ecdhPublic.x}","y":"${alice.ecdhPublic.y}"}`;
        const expected = base64url(crypto.createHash('sha256').update(canonical).digest());
        assert.equal(slot.recipient_key, expected);
        assert.equal(slot.recipient_key, await locker.jwkThumbprint(alice.ecdhPublic));
        assert.notEqual(slot.recipient_key, await locker.jwkThumbprint(bob.ecdhPublic));
        // A slot that names another key is refused before anything is derived.
        const swapped = { ...slot, recipient_key: await locker.jwkThumbprint(bob.ecdhPublic) };
        await assert.rejects(
            () => locker.unwrapPeopleSlot(swapped, alice.ecdh.privateKey),
            (err) => err.code === 'locker.wrong_key',
        );
        // And an envelope with that slot in it fails the same way.
        const bobThumbprint = await locker.jwkThumbprint(bob.ecdhPublic);
        const bytes = withHeader(sealed, (header) => ({
            ...header,
            slots: { people: [{ ...slot, recipient_key: bobThumbprint }] },
        }));
        await fails(() => locker.open(bytes, { privateKey: alice.ecdh.privateKey, subject: A }), 'locker.wrong_key');
        // A slot with no key named at all is not one we wrote.
        const nameless = { ...slot };
        delete nameless.recipient_key;
        await assert.rejects(
            () => locker.unwrapPeopleSlot(nameless, alice.ecdh.privateKey),
            (err) => err.code === 'locker.bad_envelope',
        );
    }],

    ['wrapFor wraps the content key for one person', async () => {
        const contentKey = new Uint8Array(32).fill(7);
        const slot = await locker.wrapFor(contentKey, bob.ecdhPublic, { subject: B });
        assert.equal(slot.subject.id, B.id);
        assert.equal(slot.algorithm, 'ECDH-P256/HKDF-SHA256/AES-256-GCM');
        const back = await locker.unwrapPeopleSlot(slot, bob.ecdh.privateKey);
        assert.equal(sha256(back), sha256(contentKey));
        // Another person's key does not open it.
        await assert.rejects(() => locker.unwrapPeopleSlot(slot, alice.ecdh.privateKey), (err) => err.code === 'locker.wrong_key');
    }],

    ['rewrap adds a person without touching the content', async () => {
        const sealed = await sealFor('a note');
        const again = await locker.rewrap(sealed, {
            add: [{ subject: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS' }, publicKey: alice.ecdhPublic }],
            credentials: { privateKey: alice.ecdh.privateKey, subject: A },
        });
        assert.equal(again.header.slots.people.length, 3);
        // The chunks are the same bytes: the slots are not part of what they authenticate.
        assert.equal(
            sha256(sealed.bytes.subarray(sealed.chunkOffset)),
            sha256(again.bytes.subarray(again.chunkOffset)),
        );
        // Everyone on the list can still open it.
        assert.equal(decoder.decode(await locker.open(again, { privateKey: alice.ecdh.privateKey, subject: A })), 'a note');
        assert.equal(decoder.decode(await locker.open(again, { privateKey: bob.ecdh.privateKey, subject: B })), 'a note');
    }],

    ['removing a person re-seals with a new content key', async () => {
        const sealed = await sealFor('a note');
        const oldKey = await locker.unwrapPeopleSlot(sealed.header.slots.people[0], alice.ecdh.privateKey);
        const again = await locker.rewrap(sealed, {
            remove: [B],
            keys: [{ subject: A, publicKey: alice.ecdhPublic }],
            credentials: { privateKey: alice.ecdh.privateKey, subject: A },
        });
        // Only the person who stays is on it now.
        assert.equal(again.header.slots.people.length, 1);
        assert.equal(again.header.slots.people[0].subject.id, A.id);
        assert.equal(decoder.decode(await locker.open(again, { privateKey: alice.ecdh.privateKey, subject: A })), 'a note');
        // The person who is gone has no slot.
        await fails(() => locker.open(again, { privateKey: bob.ecdh.privateKey, subject: B }), 'locker.no_key');
        // The content key is a new one, so the key the person who left still holds opens nothing.
        const newKey = await locker.unwrapPeopleSlot(again.header.slots.people[0], alice.ecdh.privateKey);
        assert.notEqual(sha256(oldKey), sha256(newKey));
        await assert.rejects(() => decryptFirstChunk(again, oldKey), 'the old content key opens nothing');
        // The nonce base is new too, so the envelope is not the old bytes with a header.
        assert.notEqual(again.header.nonce_base, sealed.header.nonce_base);
        assert.notEqual(sha256(again.bytes), sha256(sealed.bytes));
        // A removal needs the public keys of the people who stay.
        await fails(() => locker.rewrap(sealed, {
            remove: [B],
            credentials: { privateKey: alice.ecdh.privateKey, subject: A },
        }), 'locker.invalid');
    }],

    ['a caller that holds the content key needs no private key', async () => {
        const contentKey = new Uint8Array(32).fill(9);
        const sealed = await locker.seal('a note', {
            lock: 'people',
            keys: [{ subject: A, publicKey: alice.ecdhPublic }],
            contentKey,
        });
        // An agent that sealed the item kept its key: it can open it, or re-seal it for the people who
        // stay, without the private key of a recipient.
        assert.equal(decoder.decode(await locker.open(sealed, { contentKey })), 'a note');
        const again = await locker.rewrap(sealed, {
            remove: [B],
            keys: [{ subject: A, publicKey: alice.ecdhPublic }],
            credentials: { contentKey },
        });
        assert.equal(decoder.decode(await locker.open(again, { privateKey: alice.ecdh.privateKey, subject: A })), 'a note');
        // The re-seal made a new content key: the one the caller kept opens the old envelope only.
        await assert.rejects(() => locker.open(again, { contentKey }), (err) => err.code === 'locker.wrong_key');
        await fails(() => locker.open(sealed, { contentKey: new Uint8Array(31) }), 'locker.invalid');
    }],

    ['every seal makes a new key and a new nonce base', async () => {
        const one = await locker.seal('the same note', { lock: 'password', password: 'x' });
        const two = await locker.seal('the same note', { lock: 'password', password: 'x' });
        // The same bytes under the same password are two different envelopes.
        assert.notEqual(one.header.nonce_base, two.header.nonce_base);
        assert.notEqual(sha256(one.bytes), sha256(two.bytes));
        const keyOne = await locker.unwrapPasswordSlot(one.header.slots.password, 'x');
        const keyTwo = await locker.unwrapPasswordSlot(two.header.slots.password, 'x');
        assert.notEqual(sha256(keyOne), sha256(keyTwo));
        // And both open to the same note.
        assert.equal(decoder.decode(await locker.open(one, { password: 'x' })), 'the same note');
        assert.equal(decoder.decode(await locker.open(two, { password: 'x' })), 'the same note');
    }],

    ['the streams round trip', async () => {
        const content = new Uint8Array(CHUNK * 2 + 11);
        for (let i = 0; i < content.length; i++) content[i] = (i * 3) % 251;
        const source = new ReadableStream({
            start(controller) { controller.enqueue(content); controller.close(); },
        });
        const sealed = locker.sealStream(source, { lock: 'password', password: 'x', size: content.length });
        const reader = sealed.getReader();
        const parts = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value);
        }
        const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const part of parts) { bytes.set(part, at); at += part.length; }
        const opened = await locker.open(bytes, { password: 'x' });
        assert.equal(sha256(opened), sha256(content));
        // And the other way round: a stream in, a stream out.
        const back = locker.openStream(new ReadableStream({
            start(controller) { controller.enqueue(bytes); controller.close(); },
        }), { password: 'x' });
        const reader2 = back.getReader();
        const plain = [];
        for (;;) {
            const { value, done } = await reader2.read();
            if (done) break;
            plain.push(value);
        }
        const whole = new Uint8Array(plain.reduce((n, p) => n + p.length, 0));
        at = 0;
        for (const part of plain) { whole.set(part, at); at += part.length; }
        assert.equal(sha256(whole), sha256(content));
    }],

    ['a stream seal needs the size of the content', async () => {
        const source = new ReadableStream({ start(c) { c.close(); } });
        assert.throws(() => locker.sealStream(source, { lock: 'password', password: 'x' }), (err) => err.code === 'locker.invalid');
    }],

    ['a stream that ends early yields what it had, then throws', async () => {
        const content = new Uint8Array(CHUNK * 2 + 11);
        const sealed = await locker.seal(content, { lock: 'password', password: 'x' });
        const list = frames(sealed.bytes, sealed.chunkOffset);
        assert.equal(list.length, 3);
        // The last chunk never arrives: the earlier ones come out, and then the stream throws.
        const cut = sealed.bytes.subarray(0, list[list.length - 1].start);
        const stream = locker.openStream(new ReadableStream({
            start(controller) { controller.enqueue(cut); controller.close(); },
        }), { password: 'x' });
        const reader = stream.getReader();
        const parts = [];
        let error = null;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                parts.push(value);
            }
        } catch (err) { error = err; }
        assert.ok(error, 'the stream threw');
        assert.equal(error.code, 'locker.truncated');
        assert.equal(parts.length, 2, 'the two chunks that were there came out first');
        // What came out is not the whole content: the item was never complete.
        const got = parts.reduce((n, p) => n + p.length, 0);
        assert.ok(got < content.length, 'the content was not complete');
    }],

    ['a 64 MiB stream is sealed in bounded memory', async () => {
        // The check runs in its own process, with --expose-gc, so it can see what is really still
        // held after a collection instead of counting what the collector has not got to yet.
        const out = execFileSync(process.execPath, ['--expose-gc', path.join(__dirname, 'locker-memory.js')], {
            encoding: 'utf8', maxBuffer: 1024 * 1024,
        });
        const { peak, total, firstFrame } = JSON.parse(out);
        assert.ok(total > 64 * 1024 * 1024, 'the envelope holds the content');
        assert.ok(firstFrame <= 4 * 1024 * 1024, `the seal read ${firstFrame} bytes before the first frame`);
        assert.ok(peak < 32 * 1024 * 1024, `the seal held ${Math.round(peak / 1048576)} MiB for a 64 MiB stream`);
    }],

    ['the shared test vectors are the same bytes every time', async () => {
        const person = {
            ecdh: vectors.PERSON.ecdh,
            signing: vectors.PERSON.signing,
            ecdhPublic: vectors.PERSON.ecdhPublic,
            signingPublic: vectors.PERSON.signingPublic,
        };
        const random = vectors.fixedRandom();
        const people = await locker.seal(vectors.CONTENT, {
            lock: 'people',
            keys: [{ subject: vectors.SUBJECT, publicKey: person.ecdhPublic }],
            random,
            ephemeral: { private: person.ecdh },
        });
        const password = await locker.seal(vectors.CONTENT, {
            lock: 'password', password: 'correct horse battery staple', random,
        });
        const link = await locker.seal(vectors.CONTENT, { lock: 'link', random });
        const made = { people, password, link };
        for (const testCase of vectors.CASES) {
            assert.deepEqual(made[testCase.name].header, testCase.header, `the ${testCase.name} header`);
            assert.equal(sha256(made[testCase.name].bytes), testCase.envelope_sha256, `the ${testCase.name} envelope`);
        }
        // The fingerprint of the vector's keys is the one the file says.
        assert.equal(await locker.fingerprintOf(person.ecdhPublic, person.signingPublic), vectors.PERSON.fingerprint);
        // The recovery phrase is the same words on every runtime.
        assert.equal(locker.recoveryWords(24, { random: vectors.fixedRandom(0x5eed1e) }), vectors.RECOVERY.phrase);
        assert.equal(locker.isRecoveryPhrase(vectors.RECOVERY.phrase), true);
        assert.equal(vectors.RECOVERY.words.length, 24);
        // And what inspect says about each case, without a key.
        for (const testCase of vectors.CASES) {
            assert.deepEqual(locker.inspect(made[testCase.name].bytes), vectors.INSPECT[testCase.name]);
        }
        // And the vectors open with the vector's keys.
        const privateKey = await locker.importPersonKeys({ ecdh: person.ecdh, signing: person.signing });
        assert.equal(
            decoder.decode(await locker.open(people, { privateKey: privateKey.ecdhPrivateKey, subject: vectors.SUBJECT })),
            vectors.CONTENT,
        );
    }],

    ['a service can check a header without opening it', async () => {
        const sealed = await sealFor('a note');
        const checked = server.inspectEnvelope(sealed.bytes);
        assert.equal(checked.valid, true, JSON.stringify(checked.errors));
        assert.equal(checked.lock, 'people');
        assert.equal(checked.paddedSize, 256);
        assert.equal(checked.chunkCount, 1);
        assert.equal(checked.expectedBytes, sealed.bytes.length);
        // A header that says something else does not pass.
        const bytes = withHeader(sealed, (header) => ({ ...header, padded_size: 100 }));
        const bad = server.inspectEnvelope(bytes);
        assert.equal(bad.valid, false);
        assert.ok(bad.errors.length > 0);
        // Bytes that are not an envelope at all.
        assert.equal(server.inspectEnvelope(new Uint8Array([1, 2, 3])).valid, false);
        assert.equal(server.inspectEnvelope(text('hello there, this is not an envelope')).valid, false);
    }],

    ['the headers the SDK writes are the contract', async () => {
        const people = await sealFor('a note');
        const password = await locker.seal('a note', { lock: 'password', password: 'x' });
        const link = await locker.seal('a note', { lock: 'link' });
        for (const sealed of [people, password, link]) {
            const checked = contracts.validate('locker.envelope', sealed.header);
            assert.equal(checked.valid, true, JSON.stringify(checked.errors));
        }
        // And the server's own checks agree with the contract.
        assert.equal(server.checkHeader(people.header).length, 0);
        assert.equal(server.checkHeader({ ...people.header, padded_size: 100 }).length > 0, true);
    }],

    ['a service checks the header without a key', async () => {
        const sealed = await locker.seal('a note', { lock: 'password', password: 'x' });
        const checked = server.inspectEnvelope(sealed.bytes);
        assert.equal(checked.valid, true, JSON.stringify(checked.errors));
        assert.equal(checked.lock, 'password');
        assert.equal(JSON.stringify(checked.header).includes('a note'), false, 'the header holds no content');
    }],
]);
