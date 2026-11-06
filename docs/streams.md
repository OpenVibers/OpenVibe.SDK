# The Agent Streams (S1)

`openvibe-sdk/streams` drives an agent's own stream on OpenVibe.Live: the Agent Streams plan, stage 1.

An agent stream is a Live stream of kind `agent` (its id starts `ags_`). It never has a stream key and never takes a
normal slot; it is published with a **publish ticket** instead, and the ticket is what opens the door.

```js
const { createClient } = require('openvibe-sdk/core');
const { createStreamsClient } = require('openvibe-sdk/streams');

const streams = createStreamsClient(createClient({ tokenProvider }));

const { stream, publish } = await streams.startAgentStream({
    title: 'Fixing the login page',
    task: { source: 'codes', ref: 'task_01JAB…', title: 'Fix the login page' },
    visibility: 'private',
});
// publish.whip_url, publish.ticket (shown once), publish.expires_at
```

## The desk's loop

The desk (OpenVibe.Node) polls Live every ten seconds and keeps publishing while Live wants video:

```js
const s = await streams.state(stream.id, { ticket: publish.ticket });
// { viewers, encode, curtain: { up }, ends_at }

if (!s.encode) await streams.postFrame(stream.id, jpegBytes, { ticket: publish.ticket });
```

While `encode` is false the desk stops encoding and sends a snapshot every five seconds (JPEG or WebP, at most
200 KB). While the curtain is up Live pauses every viewer's consumer, so a viewer sees "Private screen" and never why.

## The privacy screen

```js
await streams.setCurtain(stream.id, true, 'password_field');   // up: a password field is focused
await streams.setCurtain(stream.id, false, 'password_field');  // down: the detectors are clear again
```

The curtain comes down only from the desk (after its detectors report clear for two seconds) or from the owner's own
button. A detector that fails or is unsure puts the curtain up and never down. The reason is the owner's only.

## The ticket

The ticket lives four hours; the desk renews it at three.

```js
const again = await streams.renewTicket(stream.id);   // a new ticket; the old one stops working
await streams.revokeTicket(stream.id);                // the kill switch: Live ends the WHIP session at once
```

The ticket is a bearer of its own: on the desk's routes (`state`, `postFrame`) the desk sends the ticket instead of
the person's token, so Live never sees the person's token there.

## Watching

```js
await streams.setVisibility(stream.id, 'unlisted');    // private | unlisted | public
const { ticket: view } = await streams.viewTicket(stream.id);   // wvt_…, ten minutes
await streams.end(stream.id);                          // the card stays, with the last frame and the VOD
```

## Who may call

The person's own session token, or a first-party service token acting for that person: a Node principal acting for its
owner (Network issues the node token with `live.agent_stream.publish` for the audience `openvibe.live` and names its
owner in `on_behalf_of`), Codes or Actor. Never a developer-app token, never another person's stream.
