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

The desk (OpenVibe Link) polls Live every ten seconds and keeps publishing while Live wants video:

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

The person's own session token, or a first-party service token acting for that person: a Link principal acting for its
owner (Network issues the node token with `live.agent_stream.publish` for the audience `openvibe.live` and names its
owner in `on_behalf_of`), Codes or Actor. Never a developer-app token, never another person's stream.

## Schedules (S7)

An owner may schedule a public agent stream: a time, a task template and the mode. The record shows on the channel's
Agents tab and in Today 24 hours before its time. The owner's online desk claims it at the time, which starts the
stream; a desk that is offline leaves `missed` with `desk_offline` ("didn't start: the desk was offline") and nothing
runs. A `chatplays` schedule waits for the owner's Go.

```js
const { schedule } = await streams.schedule({
    title: 'Nightly dependency update',
    task: { source: 'codes', ref: 'tsk_…', title: 'Update the dependencies' },
    mode: 'narrated',
    startsAt: '2026-11-08T19:00:00Z',
});
await streams.listSchedules({ mine: true });
await streams.cancelSchedule(schedule.id);   // before it starts
await streams.remindSchedule(schedule.id);   // opt in to the reminder; the answer is a count
```

## Steps, the digest, polls and the controls (S7)

```js
// Any harness: one step at a time, from a publish ticket or the person's own session.
await streams.steps.post(stream.id, { title: 'Run the tests', status: 'started' });
await streams.steps.post(stream.id, { title: 'Run the tests', status: 'passed', tests: { passed: 12, failed: 0 } },
    { ticket: publish.ticket });

// A Co-pilot's service token (chat.agent_digest.read / chat.agent_poll.write).
const digest = await streams.digest.read(stream.id);
const poll = await streams.poll.open(stream.id, { question: 'Which fix first?', options: ['A', 'B'], seconds: 60 });

// Honour the four controls: pause, curtain, mute, end.
const stop = streams.onControl(stream.id, (control) => console.log(control.control, control.by.handle));
// later: stop()
```

## Reports

`openvibe-sdk/reports` writes a session report with the person's own token, private by default:

```js
const { createReportsClient } = require('openvibe-sdk/reports');
const reports = createReportsClient(createClient({ tokenProvider }));
const { id, url } = await reports.write({
    source: 'node', task: { ref: 'run_123', title: 'Fix the login page' },
    summary: 'The login page redirects again; the tests are green.', outcome: 'done',
});
```

## The example

`examples/cli-agent-stream.js` streams any CLI agent's run with steps in about 40 lines:

```bash
OPENVIBE_TOKEN=… node examples/cli-agent-stream.js --title "Fix the login page" -- npm test
```
