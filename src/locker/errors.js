'use strict';
/**
 * The one error Locker throws. The code says what went wrong, so a caller can tell a wrong
 * password from a truncated download from bytes that are not an envelope at all.
 *
 * The codes: locker.invalid (the caller asked for something impossible), locker.bad_envelope
 * (the bytes are not an envelope we wrote), locker.truncated (the bytes stop early),
 * locker.wrong_key (the key is not the one), locker.no_key (no key was given), locker.no_slot
 * (there is no slot for this key), locker.size_mismatch (the size does not add up) and
 * locker.no_crypto (the runtime has no WebCrypto).
 */
class LockerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LockerError';
        this.code = code;
    }
}

/** A Locker error, or a plain Error with the same shape. */
function fail(code, message) { throw new LockerError(code, message); }

module.exports = { LockerError, fail };
