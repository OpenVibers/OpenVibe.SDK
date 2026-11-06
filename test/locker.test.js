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

run([
    ['a person has two key pairs and four words', async () => {
        alice = await locker.generatePersonKeys();
        bob = await locker.generatePersonKeys();
        assert.equal(alice.ecdhPublic.kty, 'EC');
        assert.equal(alice.ecdhPublic.crv, 'P-256');
        assert.equal(alice.signingPublic.kty, 'EC');
        assert.match(alice.fingerprint, /^[a-z]+ [a-z]+ [a-z]+ [a-z]+$/);
        assert.notEqual(alice.fingerprint, bob.fingerprint);
        const published = await locker.exportPersonKeys(alice);
        assert.equal(published.fingerprint, alice.fingerprint);
        assert.equal(await locker.verifyPersonKeys(published), true);
        // A fingerprint that does not belong to the keys is caught.
        assert.equal(await locker.verifyPersonKeys({ ...published, fingerprint: 'wrong words here now' }), false);
        // A signature over other keys is caught.
        const other = await locker.exportPersonKeys(bob);
        assert.equal(await locker.verifyPersonKeys({ ...published, fingerprint_signature: other.fingerprint_signature }), false);
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
            assert.equal(sealed.header.padded_size % CHUNK, 0, `the padded size is a whole number of chunks (${size})`);
            assert.ok(sealed.header.padded_size >= size, 'the padded size covers the content');
            const opened = await locker.open(sealed, { password: 'x' });
            assert.equal(opened.length, size, `the content comes back whole (${size})`);
            assert.equal(sha256(opened), sha256(content), `the content is the same (${size})`);
        }
    }],

    ['the server sees the padded size, not the size', async () => {
        const sealed = await locker.seal('short', { lock: 'password', password: 'x' });
        assert.equal(sealed.header.padded_size, CHUNK);
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
        assert.equal(checked.paddedSize, CHUNK);
        assert.equal(checked.chunkCount, 1);
        assert.equal(checked.expectedBytes, sealed.bytes.length);
        // A header that says something else does not pass.
        const bytes = sealed.bytes.slice();
        bytes.set(text(decoder.decode(bytes.subarray(8, sealed.chunkOffset)).replace('"padded_size":1048576', '"padded_size":1000')), 8);
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
        assert.equal(server.checkHeader({ ...people.header, padded_size: 1000 }).length > 0, true);
    }],

    ['a service checks the header without a key', async () => {
        const sealed = await locker.seal('a note', { lock: 'password', password: 'x' });
        const checked = server.inspectEnvelope(sealed.bytes);
        assert.equal(checked.valid, true, JSON.stringify(checked.errors));
        assert.equal(checked.lock, 'password');
        assert.equal(JSON.stringify(checked.header).includes('a note'), false, 'the header holds no content');
    }],
]);
