'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const locker = require('../src/locker');
const { PERSON, fixedRandom } = require('../src/locker/vectors');

const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../testdata/blind-fill-link-send-v1.json'), 'utf8'));

run([['Locker blind-fill Link Send vector is stable and opens in the SDK', async () => {
    const sealed = await locker.seal(vector.plaintext_json, {
        lock: 'people',
        keys: [{ subject: vector.recipient, publicKey: PERSON.ecdhPublic }],
        random: fixedRandom(0x4f565f46),
        ephemeral: { private: PERSON.ecdh },
    });
    assert.equal(Buffer.from(sealed.bytes).toString('base64'), vector.envelope_base64, 'SDK generation matches the cross-language fixture');
    const opened = await locker.open(Buffer.from(vector.envelope_base64, 'base64'), {
        privateKey: PERSON.ecdh,
        subject: vector.recipient,
    });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), vector.expected);
}]]);
