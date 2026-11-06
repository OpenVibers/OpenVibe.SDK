# Locker: end-to-end encryption, in the SDK

`openvibe-sdk/locker` seals anything and opens it again, in Node and in the browser, with WebCrypto
only: `globalThis.crypto.subtle`, no other crypto library, nothing hand-rolled. The format is
`locker.envelope@1` in OpenVibe.Contracts; the written-out format is
[docs/locker.md in Contracts](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/locker.md).

With a locked item, OpenVibe stores and serves only ciphertext. The keys never reach our servers, and
neither does anything that can read the content.

```bash
npm install openvibe-sdk          # the package; the subpaths need no extra install
```

```js
const { seal, open, generatePersonKeys } = require('openvibe-sdk/locker');
```

In a browser, with a bundler, the same names come from `openvibe-sdk/locker`; with no bundler, from the
one-file bundle `browser/openvibe-sdk.mjs` (`sdk.locker`).

## The three locks

| Lock | Who can open it | What you need to open it |
| --- | --- | --- |
| `people` | you and the people you share with | your private key |
| `password` | anyone you give the password to | the password |
| `link` | anyone with the full link | the key from the part after `#` |

## Sealing and opening

```js
const person = await generatePersonKeys();
// person.ecdhPublic, person.signingPublic, person.fingerprint ("eight words")
const subject = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };

// For the people on the list.
const sealed = await seal('a note for @maticus', {
    lock: 'people',
    keys: [{ subject, publicKey: person.ecdhPublic }],
});
const note = await open(sealed, { privateKey: person.ecdh.privateKey, subject });

// With a password.
const withPassword = await seal('a note', { lock: 'password', password: 'correct horse battery staple' });
await open(withPassword, { password: 'correct horse battery staple' });

// With the link: the key travels in the part after the #, which browsers never send to us.
const withLink = await seal('a note', { lock: 'link' });
const url = `https://openvibe.example/paste/abc#${withLink.linkKey}`;
await open(withLink, { key: withLink.linkKey });
```

`seal` takes a string or bytes and returns an envelope:

```js
{
    version: 'locker.envelope.v1',
    header,        // the JSON that opens every chunk (locker.envelope@1)
    headerBytes,
    bytes,         // the whole envelope: magic, header, chunks
    chunkOffset,   // where the chunks start in bytes
    linkKey,       // a link lock only: the content key, for the link
}
```

`open` takes that envelope (or its bytes) and the credentials of the lock it names, and returns the
content as bytes. A wrong key, a changed header, a changed chunk, chunks in the wrong order and a
missing last chunk all fail with a `LockerError` whose `code` says what went wrong
(`locker.wrong_key`, `locker.truncated`, `locker.bad_envelope`, `locker.no_key`).

The header holds the **padded size**, not the size: the content is padded with Padmé (PoPETs 2019), so
a 200-byte note costs 256 bytes and not a whole megabyte, the expansion stays under about twelve per
cent, and the padded size leaks only O(log log n) bits about the real one. `locker.padme(size)` gives the
padded size of a content of that size; every chunk but the last is a whole chunk, and the last holds the
rest.

## Files: the streams

A large file never has to fit in memory, in either direction.

```js
const sealed = locker.sealStream(file.stream(), { lock: 'people', keys, size: file.size });
const plain = locker.openStream(await (await fetch(url)).body, { privateKey, subject });
```

`sealStream` needs the size of the content: the padded size is in the header, and the header is written
first. The stream holds one chunk at a time (1 MiB), so sealing a 64 MiB file costs a few MiB of
memory, not 64.

`openStream` yields the chunks as it verifies them, so it gives you the earlier ones before it reaches the
last one. **A stream that ends early throws at the end**, when the missing chunk shows up: discard what
it yielded, because the content was never complete. The same goes for the whole-content `open`: it either
returns everything or it fails.

## Sharing: wrapFor and rewrap

The content key is wrapped for one person at a time, so adding a member to a people-locked item does
not re-encrypt the content: the slots are not part of what the chunks authenticate.

```js
const slot = await wrapFor(contentKey, person.ecdhPublic, { subject });

const again = await rewrap(sealed, {
    add: [{ subject: other, publicKey: otherPerson.ecdhPublic }],
    credentials: { privateKey: person.ecdh.privateKey, subject },
});
```

`rewrap` keeps the slots of the people who are already on it and gives the new ones one of their own;
the chunks are the same bytes.

Removing a member wants a fresh content key, not a slot that is gone: the person who is removed may still
hold the old key, and it would open the item again. So a removal opens the content and seals it again with
a new content key and a new nonce base, for the people who are left. Their public keys are needed for that,
so the caller gives them in `keys`:

```js
const without = await rewrap(sealed, {
    remove: [other],
    keys: [{ subject, publicKey: person.ecdhPublic }],
    credentials: { privateKey: person.ecdh.privateKey, subject },
});
```

The old content key opens nothing now, and the person who left has no slot at all.

## A person's keys

A person has two key pairs: an **ECDH P-256** pair that receives content keys and an **ECDSA P-256**
pair that signs the fingerprint. The **fingerprint** is eight words in two groups of four (the first eight
bytes of SHA-256 over both public keys, read from a list of 256 words): short enough to read out loud and
compare once, and sixty-four bits, so a server that swapped in its own key would need about 2^64 key
generations to match it. The signature over both public keys proves the holder owns the signing key, so
the pair is self-certifying, and a change of keys changes the eight words.

```js
const person = await generatePersonKeys();
const published = await exportPersonKeys(person);   // locker.public-keys@1
await verifyPersonKeys(published);                  // true
```

The private keys are stored wrapped, by a key from the locker passphrase (PBKDF2-SHA-256) or by a
passkey; see `locker.key-backup@1` in Contracts. There is no reset: if the passphrase and the recovery
kit are both lost, nobody can open the locker, including OpenVibe.

## What a service does: openvibe-sdk/locker/server

A service stores an envelope as opaque bytes and never opens it. This module gives it the checks in
one place, and needs no key:

```js
const { inspectEnvelope } = require('openvibe-sdk/locker/server');
const info = inspectEnvelope(bytes);
// { valid, errors, header, headerLength, chunkOffset, lock, paddedSize, chunkCount, expectedBytes }
```

It reads the header and checks its shape and the envelope's size, without decrypting anything. Then the
service skips indexing, previews, thumbnails, transcoding and content AI, shows the lock badge, and
serves the bytes only to the people `canView` allows. A locked item is never public, and locked storage
has per-account quotas.

## The shared test vectors

`openvibe-sdk/locker/vectors` holds the cases the browser module (`openvibe-shared/ov-locker.js`) runs
as well: the same fixed keys, the same fixed byte source, the same content, and the header and the
envelope hash they must produce. Both runtimes must give the same bytes for the same input.

```js
const { CASES, PERSON, SUBJECT, CONTENT, fixedRandom } = require('openvibe-sdk/locker/vectors');
```

## What we cannot do

We cannot scan or moderate what is inside a locked item. That matters most for uploads. A recipient can
always keep what they opened, and the server still sees who owns what, how big it is (padded) and when.
