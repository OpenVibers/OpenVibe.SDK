# openvibe-sdk/exchange

OpenVibe.Exchange, the buyer and the seller side of the model exchange (the plan of 2026-11-06, "For builders",
item 7). The buyer side speaks the Exchange's v1 API with a Network developer key; the seller side registers an
offer in the Network's user-owned AI offers, the same registry OpenVibe Link's "Offer to the network" uses.

```js
const { createExchangeClient } = require('openvibe-sdk/exchange');

const exchange = createExchangeClient({ developerKey: process.env.OPENVIBE_DEVELOPER_KEY });

const answer = await exchange.chat({
    model: 'openvibe',
    messages: [{ role: 'user', content: 'Write a haiku about the sea.' }],
});
// { id: 'chatcmpl-…', object: 'chat.completion', choices, usage, x_openvibe: { run_id, cost_usd, … } }
```

## The buyer side

Every call takes an `AbortSignal`, and a 429 or a 5xx is retried with a jittered backoff. A safe method is
always retried; a write is only retried when it is idempotent (the seller report is), because a completion that ran
twice is a completion billed twice.

| call | where it goes | what it answers |
|---|---|---|
| `chat(body, {signal})` | `POST /v1/chat/completions` | the OpenAI shape: `{id, object, created, model, choices, usage, x_openvibe}` |
| `models({signal})` | `GET /v1/models` | `{object: 'list', data: [...]}` |
| `offers(model, {signal})` | `GET /api/v1/exchange/models/:org/:model` | the offers that serve one model, with the price, the measured speed and the uptime |
| `catalog({signal})` | `GET /api/v1/exchange/catalog` | every model and its offers |
| `presets.list({signal})` | `GET /api/v1/presets` | the five built-in routing profiles and the caller's own |
| `presets.create({name, policy})` | `POST /api/v1/presets` | the stored preset |
| `presets.update(name, {policy})` | `POST /api/v1/presets` | the replaced preset (the platform stores a preset under its name; there is no PATCH) |
| `presets.remove(name)` | `DELETE /api/v1/presets/:name` | the removal |
| `usage({days})` | `GET /api/v1/exchange/usage` | the public aggregate: requests, tokens and spend by day, by model and by product |
| `usage({from, to, requester})` | `GET /api/v1/usage` | the platform's own usage for that requester (the capability `ai.usage.read`) |
| `receipt(id, {signal})` | `GET /v1/receipts/:id` | the receipt of one answered request |

A receipt says, in one place, the offer that answered, the price it charged, the tokens, why the router chose it,
the fallbacks it would have used, who paid and the privacy label of the answer. It never carries the prompt or the
answer.

### Streaming

`stream: true` answers an async iterable of chunks instead of the finished completion. The last chunk carries the
OpenVibe fields (`x_openvibe`); the stream ends with `data: [DONE]`.

```js
for await (const chunk of exchange.chat({ model: 'openvibe', messages, stream: true })) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### A preset

A preset is a saved routing profile: the objective (cheapest, fastest, balanced, private), the floor, the ceiling,
the max price, the quantizations, the regions, the privacy class, whether a community machine may answer and the
adult gate. A request names one as `model: '@preset/<name>'`.

## The seller side

An offer has two forms. A **Link machine** reports its offer to the Network's user-owned AI offers — the same registry
OpenVibe Link's "Offer to the network" writes to (`POST /internal/ai/offers/report`, the capability
`network.resource.report`). A **standalone server** registers itself on the Exchange's public seller API with the
developer key, so it needs no Link at all. The SDK validates both before anything is sent.

```js
const offer = await exchange.seller.offer({
    model: 'qwen3:32b',
    price: { in_per_million: 0, out_per_million: 0 },   // 0 volunteers the model
    hours: { start: '18:00', end: '23:30', tz: 'Europe/Lisbon' },
    concurrency: 2,
    endpoint: 'https://my-server.example/v1',            // the OpenAI-compatible server
    machineId: 'dev_…',                                  // the machine the offer belongs to
    owner: 'usr_…',                                       // the person who owns it
});
// { offer: {offer_id: 'ai:dev_…', models, hours, concurrency, price, audience, ready, health}, report, endpoint }
```

The offer document is strict: the registry refuses a field it does not know, so the SDK sends exactly its shape
(`offer_id`, `machine_id`, `owner`, `models`, `hours`, `concurrency`, `price`, `audience`, `group`,
`ready`, `health`). The hours are one local window (start == end is all day, an overnight window wraps), the
concurrency is 1 to 8, the price is credits per million tokens, and the audience is `everyone`, `followers` or
`group` (with a group id). The SDK refuses an offer the registry would refuse before anything is sent.

The endpoint is checked first: the SDK asks the server for its OpenAI model list, so a server that does not speak
the OpenAI API is caught before the offer is registered (`probe: false` turns that off).

### A standalone server: the endpoint form

A server that speaks the OpenAI Chat Completions API can sell without an OpenVibe Link. Give `endpoint` and no
`machineId`; the offer is registered on the Exchange's public seller API
(`POST /api/v1/exchange/seller/offers`) with the same developer key as the buyer side.

```js
const { offer, endpoint } = await exchange.seller.offer({
    endpoint: 'https://my-server.example/v1',   // https only: the platform refuses an IP literal or port other than 443/8443
    models: ['qwen3:32b', 'qwen3:8b'],
    price: { in_per_million: 10, out_per_million: 30 },   // 0 volunteers
    hours: { start: '00:00', end: '23:59', tz: 'Europe/Lisbon' },
    concurrency: 2,
    audience: 'everyone',
    name: 'my 3090',
});
// { offer: { id: 'ep_…', offer_id: 'endpoint:ep_…', base_url, models, hours, price, audience, … },
//   endpoint: { url, models } }

const { owner, offers } = await exchange.seller.endpointOffers();
await exchange.seller.removeEndpointOffer(offer.id);
```

The owner is the person the developer key acts for (a developer app's project owner), never a body field. AI reaches
the address only through its egress guard: https, a public DNS answer checked inside the connection (never an IP
literal), redirects judged again, a timeout, a response byte cap, and no buyer identity in any header. No bearer token
is sent, so the endpoint must accept the POST as it is (`endpointKey` only authenticates the SDK's own probe). The
endpoint is verified exactly as a machine running Link (the canaries, the model fingerprint, about 1% spot re-runs), serves the
free tier only until verified, and earns 0 on the owner's own requests. An answer from it is labelled a community
endpoint on the receipt (`provider: community-endpoint:<id>`, `provider_access: COMMUNITY_ENDPOINT`). It sees the
prompt: only requests that opt in to community capacity reach it.

### Earnings and verification

```js
const { totals, offers } = await exchange.seller.earnings();
// totals: { requests, tokens_in, tokens_out, pending_credits_micro, spendable_credits_micro, self_served_requests }

const { offers } = await exchange.seller.verification();
// offers[0]: { verification: { status, canary_passes, canary_failures, spot_runs, spot_failures, … },
//              reputation, free_only, uptime_pct, verified }
```

The owner is named in `X-OV-Subject`; pass `owner` to the client or to the call. Before any traffic, the router
runs canary prompts with known answers and checks the model id the server reports against the one the owner
declared; about 1% of the answers are re-run on another trusted machine with the same model and compared. A new
machine serves the free tier only until it passes, and a failure stops the traffic to it.

## Webhooks

The usage, the earnings and the offer-down events carry `X-OpenVibe-Signature-V2`: `t=<unix seconds>`,
`v2=<hex HMAC-SHA256 of "<t>.<raw body>">`. The check is in constant time and refuses a timestamp more than 300
seconds either way; the platform's legacy `sha256=<hex>` of the body alone is accepted too (it has no timestamp,
so it is replayable).

```js
const { verifyWebhook } = require('openvibe-sdk/exchange');

app.post('/webhooks/exchange', (req, res) => {
    if (!verifyWebhook(req.rawBody, req.headers['x-openvibe-signature-v2'], process.env.OPENVIBE_WEBHOOK_SECRET)) {
        return res.status(400).end();
    }
    res.end('ok');
});
```

Always pass the raw body: a re-serialised object changes the bytes and the signature stops matching.

## Errors

A refusal becomes an `ExchangeError` with the status, the code and the body (`status`, `code`, `body`,
`retryAfter`, and `retryable` for a status worth another try). The OpenAI-shaped `{error: {message, type, code,
param}}` answer and the platform's problem+json are both read.

## The client

```
createExchangeClient({
    developerKey,            // the Network developer key (Bearer)
    networkKey,              // the key on the Network's own origin; defaults to the developer key
    baseUrl,                 // default https://api.openvibe.exchange
    networkUrl,              // default https://api.openvibe.network
    fetchImpl, timeoutMs,    // default 60000
    maxRetries, retryBaseMs, // default 3 and 250
    owner,                   // the seller subject (usr_…)
    paths,                   // the paths, when a deployment moves them
    agent,
})
```
