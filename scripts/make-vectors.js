'use strict';
/**
 * Regenerates src/locker/vectors.js from the library, so the shared vectors are the bytes the
 * library writes today. Run from the SDK root: node scripts/make-vectors.js
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const locker = require('../src/locker');
const { fixedRandom, CONTENT, PERSON, SUBJECT } = require('../src/locker/vectors');

const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

(async () => {
    const person = {
        ecdh: PERSON.ecdh,
        signing: PERSON.signing,
        ecdhPublic: PERSON.ecdhPublic,
        signingPublic: PERSON.signingPublic,
    };
    const random = fixedRandom();
    const made = {
        people: await locker.seal(CONTENT, {
            lock: 'people',
            keys: [{ subject: SUBJECT, publicKey: person.ecdhPublic }],
            random,
            ephemeral: { private: person.ecdh },
        }),
        password: await locker.seal(CONTENT, {
            lock: 'password', password: 'correct horse battery staple', random,
        }),
        link: await locker.seal(CONTENT, { lock: 'link', random }),
    };
    const fingerprint = await locker.fingerprintOf(person.ecdhPublic, person.signingPublic);
    const cases = ['people', 'password', 'link'].map(name => ({
        name,
        envelope_sha256: sha256(made[name].bytes),
        header: made[name].header,
    }));
    const file = `\
'use strict';
/**
 * The shared test vectors. The browser module (openvibe-shared/ov-locker.js) runs the same cases,
 * so both runtimes must produce the same bytes for the same input: the same header, the same
 * envelope, the same eight words.
 *
 * Everything here is fixed: the keys, the byte source and the content. The keys below are test
 * keys, made for this file and used for nothing else.
 */

/**
 * A fixed byte source: the same bytes every time, so a vector is the same on every runtime and
 * in every browser. It is a test helper, not a random source: never use it for anything real.
 */
function fixedRandom(seed = 0x1a2b3c4d) {
    let state = seed >>> 0;
    return (length) => {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            state ^= state << 13; state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5; state >>>= 0;
            out[i] = state & 0xff;
        }
        return out;
    };
}

/** The content of every case. */
const CONTENT = ${JSON.stringify(CONTENT)};

/** A person's keys, made for these vectors. */
const PERSON = ${JSON.stringify({ ...PERSON, fingerprint }, null, 4)};

/** The subject the people case is for. */
const SUBJECT = ${JSON.stringify(SUBJECT, null, 4)};

/** The cases: the same content, sealed three ways. */
const CASES = ${JSON.stringify(cases, null, 4)};

module.exports = { fixedRandom, CONTENT, PERSON, SUBJECT, CASES };
`;
    fs.writeFileSync(path.join(__dirname, '..', 'src', 'locker', 'vectors.js'), file);
    console.log('wrote src/locker/vectors.js');
    console.log('fingerprint:', fingerprint);
    for (const testCase of cases) {
        console.log(testCase.name, testCase.envelope_sha256, 'padded', testCase.header.padded_size);
    }
})();
