'use strict';
/**
 * inspect: what an envelope says about itself, without a key and without decrypting anything.
 *
 * A service, or a page that shows a locked item, often needs to know the lock kind, how big
 * the item is, who it is for and how strong the password is — before it has any key at all.
 * This reads the header and nothing else: no chunk is touched and no key is used.
 *
 * The header holds no content, only wrapped keys, so this says nothing the server does not
 * already see.
 */
const { envelopeBytes, readCore } = require('./seal');
const { readHeader } = require('./format');

/**
 * What an envelope says about itself.
 *
 *   { version, lock, padded_size, recipients, iterations }
 *
 * `recipients` holds the thumbprint of each recipient's key for a people lock (the same
 * strings the slots carry), and `iterations` the PBKDF2 count for a password lock. The other
 * field is empty for the other lock kinds.
 */
function inspect(bytes) {
    const data = envelopeBytes(bytes);
    const { header } = readHeader(data);
    readCore(header);
    const out = {
        version: header.version,
        lock: header.lock,
        padded_size: header.padded_size,
        recipients: [],
        iterations: null,
    };
    if (header.lock === 'people') {
        out.recipients = (header.slots.people || []).map(slot => slot.recipient_key);
    } else if (header.lock === 'password' && header.slots.password) {
        out.iterations = header.slots.password.iterations;
    }
    return out;
}

module.exports = { inspect };
