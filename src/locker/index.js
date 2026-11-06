'use strict';
/**
 * openvibe-sdk/locker: end-to-end encryption for anything on OpenVibe.
 *
 * One format, one library, two runtimes: Node and the browser, WebCrypto only. A locked item is
 * stored and served as ciphertext; the keys never reach our servers.
 *
 *   const { seal, open, generatePersonKeys } = locker;   // openvibe-sdk/locker
 *   const person = await generatePersonKeys();
 *   const sealed = await seal('a note', { lock: 'people', keys: [{ subject, publicKey: person.ecdhPublic }] });
 *   const note = await open(sealed, { privateKey: person.ecdh.privateKey, subject });
 */
const format = require('./format');
const keys = require('./keys');
const seal = require('./seal');
const { padme } = require('./padme');
const { LockerError } = require('./errors');

module.exports = {
    // The format.
    VERSION: format.VERSION,
    SUITE: format.SUITE,
    CHUNK_SIZE: format.CHUNK_SIZE,
    MIN_PADDED_SIZE: format.MIN_PADDED_SIZE,
    MAX_HEADER_BYTES: format.MAX_HEADER_BYTES,
    PASSWORD_ITERATIONS: keys.PASSWORD_ITERATIONS,
    PASSWORD_ITERATIONS_MIN: keys.PASSWORD_ITERATIONS_MIN,
    PASSWORD_ITERATIONS_MAX: keys.PASSWORD_ITERATIONS_MAX,

    // The content.
    seal: seal.seal,
    open: seal.open,
    sealStream: seal.sealStream,
    openStream: seal.openStream,
    rewrap: seal.rewrap,

    // The padding: the padded size of a content of a given size.
    padme,

    // A person's keys, and the eight words that say which keys they are.
    generatePersonKeys: keys.generatePersonKeys,
    exportPersonKeys: keys.exportPersonKeys,
    exportPrivateKeys: keys.exportPrivateKeys,
    importPersonKeys: keys.importPersonKeys,
    verifyPersonKeys: keys.verifyPersonKeys,
    fingerprintOf: keys.fingerprintOf,
    fingerprintWords: keys.fingerprintWords,
    jwkThumbprint: keys.jwkThumbprint,

    // The key slots: the content key, wrapped for one person or for one password.
    wrapFor: keys.wrapFor,
    wrapForPassword: keys.wrapForPassword,
    unwrapPeopleSlot: keys.unwrapPeopleSlot,
    unwrapPasswordSlot: keys.unwrapPasswordSlot,

    LockerError,
};
