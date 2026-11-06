'use strict';
/**
 * The one error Locker throws. The code says what went wrong, so a caller can tell a wrong
 * password from a truncated download from bytes that are not an envelope at all.
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
