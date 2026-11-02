# openvibe-sdk/redact

The shared secret scrubber for memory (Memory M2). It is the JavaScript port of OpenVibe.Node's
`internal/memory/redact.go` (Node #87), so the Node and OpenVibe.AI run one shape list against one corpus.

```js
const { redact, onlySecret } = require('openvibe-sdk/redact');

const { text, count } = redact('the token is ghp_… and the deploy works');
// text: "the token is [redacted] and the deploy works", count: 1

onlySecret('[redacted]');          // true: an item that was only a secret is refused
onlySecret('a note about [redacted]'); // false
```

## What it removes

- the keys and tokens of the tools and services: AWS, GitHub, GitLab, npm, Hugging Face, Google, Slack, Discord,
  Telegram, Stripe, Twilio, SendGrid, OpenAI, Anthropic, JWTs, OpenVibe `hbt_` and Phoenix Grove `pgsk_` keys;
- private key blocks in every PEM form, including a block with no END line (from its BEGIN line to the end of the
  markdown fence it sits in, or to the end of the text);
- authorization and `x-api-key` headers, bearer tokens, and chat webhook URLs (the whole URL, because the token is in
  its path);
- connection strings: the scheme, user and host stay, the password goes;
- assignments whose name is a credential name (`DATABASE_PASSWORD=`, `api_key:`, `access_key =>`, `max_tokens:`): the
  name and separator stay, the value goes. The rule is deliberately wide, because a value may be a token count or a
  passphrase;
- prose such as "the password is …";
- card numbers that pass the Luhn check, with spaces or dashes.

A text that was already redacted is left alone. The count is the number of secrets removed, one per match.

## Why the whole-text pass exists

The Node scrubs a whole file with a sentinel before it splits the file into items, then scrubs each item. A key block
or an `.env` block that spans two items is only seen whole. `redact()` runs the same two passes on one string: the
sentinel keeps the place of each secret until the text is resolved to `[redacted]`. This is also why AI runs the
scrubber again before sealing an item: the Node is not the only writer.

## Corpus

`test/redact-corpus.json` is the shared list: every shape, the split and unterminated key blocks, the `.env` block and
the harmless texts that must not change. `test/redact.test.js` runs it here; OpenVibe.Node copies the file into
`internal/memory/testdata/` and runs the same cases against its Go `Redact`.
