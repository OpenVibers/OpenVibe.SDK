# `openvibe-sdk/consent` — ask before using a person's content

**L24, 2026-10-31.** Nothing a person makes is off-limits to AI or data use by design. Each use is **off until
that person turns it on** in OpenVibe.Network. A service asks this check before it uses a person's content or
likeness, and treats every doubt as "off".

```js
const { createConsent } = require('openvibe-sdk/consent');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const tokens = createServiceTokenClient({
    clientId: 'ai', clientSecret: process.env.OV_CLIENT_SECRET, audience: 'openvibe.network',
});
const consent = createConsent({ networkUrl: 'https://openvibe.network', token: () => tokens.getToken() });

// A dataset build: keep only the rows whose author turned ai.train on for that kind of content.
const rows = await loadCandidateRows();
const authors = [...new Set(rows.map((row) => row.author))];
const allowed = new Set(await consent.filter(authors, 'ai.train', { kind: 'posts' }));
const build = rows.filter((row) => allowed.has(row.author));
```

`filter` asks in batches of 500 (the check's limit), keeps input order and drops duplicates. `allowed(subject,
purpose, opts)` is the single-person form:

```js
if (await consent.allowed(row.author, 'data.public', { kind: 'pictures' })) {
    publish(row);       // the licence the person chose is recorded with the dataset release
}
```

Each answer is true **only** for an active choice that covers the purpose, the kind (empty kinds cover every kind),
the client (`app.data` names the app) and the feature (`face.recognize`: `verify`, `find`, `cast` or `library`). The
purposes are `ai.train`, `data.public`, `face.recognize` and `app.data`.

## The cache, and the events

An answer is cached for `ttlMs` (60 000 by default), per subject, purpose, kind, client and feature — a different
question is a different entry. Wire the change event where the service receives Events:

```js
// In the handler that receives the network.consent.changed event (Events client, worker or webhook):
consent.onChange(event);              // drops that subject's answers for that purpose at once
// …and if a use is running for them, check again before it goes on.
```

`onChange` accepts the event envelope, its payload, or a bare `{ subject, purpose }`; with neither it clears the
whole cache. An answer that was already in flight when the change arrived is **not** stored, so a revocation cannot
be overwritten by a stale response.

## Fails closed

A network error, the 2 s timeout, a non-200, a malformed answer or a token that cannot be minted is `false` for
everyone asked. A failure is never cached as a yes; the next call asks again. It logs at most once a minute (pass
`log: null` to silence it). The service-side rule is the same: when Network cannot answer, every purpose is off.

## Tests

```js
consent.mock({ usr_01JAB2C3D4E5F6G7H8J9K0MNPA: ['ai.train', 'data.public'] });
await consent.allowed('usr_01JAB2C3D4E5F6G7H8J9K0MNPA', 'ai.train');   // true, no network
consent.mock(null);                                                    // back to the live check
```

`createConsent` is server-side: `token` is a service token for OpenVibe.Network with `network.consent.read`.
Options: `ttlMs`, `fetch`, `log`, and (for tests) `timeoutMs` and `now`.
