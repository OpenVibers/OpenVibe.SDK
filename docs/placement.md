# openvibe-sdk/placement

Where a workload runs (roadmap WS-Z9, decision 43). `plan()` is the contract-shaped planner: hard constraints
first, then cost and latency, with marginal cost after free allowances, owned-capacity load, hysteresis and signed
route plans. It is pure: the caller passes the offers, rate cards, provider states and `now`.

This release adds the placement brain's A1 layer: **`place()`** wraps `plan()` with a quality bar, a success
estimate, the person's own rules, learning from outcomes, escalation and one plain sentence saying why. Everything
stays pure (no I/O, no clock, no randomness); `now` always comes in.

```js
const { place, learn, escalate } = require('openvibe-sdk/placement');

const out = place(
    { kind: 'harness.edit', mobility: 'job', latency_class: 'interactive', objective: 'balanced',
      capabilities: ['task:edit'], trust: ['user-owned', 'first-party'] },
    offers,                         // platform.resource-offer@1
    {
        now: Date.parse('2026-10-30T12:00:00Z'),
        rateCards, states,          // everything plan() takes
        person: 'usr_…',
        step: { kind: 'code.fix' }, // for quality and learning (free text, dotted)
        floor: 0.6,                 // the quality bar for this kind; default 0.5
        priors: { 'app:codes/claude-code@opus': 0.82 },
        outcomes,                   // the learned counts (below)
        rules: { noCloud: true, onlyFree: false, region: 'eu', prefer: 'cheapest' },
        names: { 'node:desk': 'your desktop' },
    },
);

out.result;   // platform.placement-result@1 — exactly what plan() returns for the offers left in; validate it
out.line;     // "On your desktop: it has your Claude sign-in and your files, and it's free."
out.ranked;   // [{ id, success, cost_usd, cost_per_success_usd }], best first by the planner's score
out.rejected; // [{ id, why }] — every exclusion, in plain words
out.fallback; // when nothing meets the bar: { id, success } of the best below it, else null
out.floor;    // the bar this answer used (carried by escalate)
out.escalations; // how many escalations led here (0..2)
out.excluded; // every rejected id, so escalate can keep them out of the next try
```

`place()` applies, in this order: the rules and ownership; the success estimate; the floor (an offer below it is
rejected with `below the bar for code.fix (52% < 60%)`); `plan()` with `success: { [offer_id]: p }`; the line. When
every offer misses the bar, `result.selected` is `null`, `fallback` is the best one below it, and the line says
`Nothing meets the bar for code.fix; the best is MiniMax M2 at 52%. Ask before going ahead?` The caller asks the
person and never goes ahead silently.

## The option key

A route is learned per **option key**: `offer_id` plus the offer's model (or harness) when it carries one.

```js
optionKey({ offer_id: 'app:codes/claude-code', model: 'opus' }); // 'app:codes/claude-code@opus'
optionKey({ offer_id: 'node:01J…' });                           // 'node:01J…'
```

Consumers build prior keys and outcome keys with the exported `optionKey(offer)`, never by hand.

## The person's rules

`rules` is a hard filter: never weighed, never traded for price. Each has its own reason in `rejected`.

| Rule | Effect |
|---|---|
| `noCloud: true` | only `trust: 'user-owned'` offers owned by `person` |
| `onlyFree: true` | `max_cost_usd: 0` (free allowances and owned capacity still qualify) |
| `region: 'eu'` | `residency: 'eu'` |
| `uncensored: true` | without it, offers with the capability `model:uncensored` are excluded |
| `maxCostUsd: n` | the lower of this and `requirements.max_cost_usd` |
| `prefer: 'cheapest' \| 'fastest' \| 'balanced'` | the objective (`cheapest`, `lowest-latency`, `balanced`) unless the requirements name one |

**A user-owned offer belongs to one person.** It is eligible only when its `owner` is the `person` of this step. A
user-owned offer with no owner, or with another owner, is never eligible; a `place()` call with no `person` cannot
use one. `plan()` itself does not know the person, so it only applies the contract's trust rule: when
`requirements.trust` is absent the default is `DEFAULT_TRUST` — first-party, partner, community and external.
`user-owned` is never a default; it is eligible only when the requirements name it. `TRUST_ORDER` remains the
five-class preference order.

**A streaming machine.** When an offer says its machine is streaming, a step that asks for a GPU or 2 or more cores
is excluded with `it is streaming`. The contract does not carry that field yet; `place()` reads
`offer.health.streaming === true` (and tolerates a top-level `offer.streaming`), so OpenVibe.Node can start sending
it without another SDK change. Node's status already reports `screen.state`, but Bot's `platform.resource-offer@1`
does not project it today.

## Learning from outcomes

Counts are plain data, one row per (person, option key, step kind):

```js
const outcomes = [
    { person: 'usr_…', key: 'app:codes/claude-code@opus', kind: 'code.fix', ok_w: 9, n_w: 10,
      updated_at: '2026-10-30T12:00:00.000Z' },
];

learn(outcomes, { person, key, kind, ok: true, at: now });      // → new outcomes, never mutates
successOf(outcomes, { person, key, kind, prior, now });         // → p in [0, 1]
```

Each count decays with a 14-day half-life, applied at read and write time from `updated_at`: what a route did a
month ago counts for a quarter. The estimate is a Beta mean

```
p = (k·prior + okP + w·okG) / (k + nP + w·nG)
```

where `okP`/`nP` are this person's decayed successes and tries, `okG`/`nG` are **everyone else's** for the same pair
(the person's own rows are not counted twice), `w = min(1, 20 / nG)`, the prior is Bench's score for this key on this
kind (0.7 when Bench has none), and `k` is 4 with a Bench prior and 2 without one. With no counts for `code.fix` the
kind falls back to `code`, then to the key's counts over every kind. A successful outcome means the step finished and
its checks passed (Codes' proof, Run's exit 0, Actor's grounded check); a failure, a timeout or a result the person
rejected is `ok: false`; a step the person cancelled is not counted.

`place()` takes the outcomes and passes the per-offer estimate to `plan()`. When the success map is present the cost
part of the score is `estimated_cost_usd / p` (cost per success); `estimated_cost_usd` in the result stays the raw
cost. When it is absent, `plan()` scores exactly as before.

## Escalation

```js
escalate(previous, failure, requirements, offers, ctx); // → the next place() answer
```

`failure.reason` is one of:

- `quality` — the result was wrong: exclude the failed option and raise the floor by 0.1;
- `busy` or `offline` — exclude it for this step; the floor stays;
- `refused` or `budget` — a provider said no: exclude every offer from that provider for this step;
- `timeout` — exclude it and prefer `lowest-latency`.

The failed option is `failure.option_id` (or `failure.id`), else `previous.result.selected`. At most two escalations
per step; the third failure returns `{ result: { selected: null } }` and a line asking the person.

**The failed try is already learned here, exactly once.** `escalate()` calls `learn()` and returns the new count set as
`outcomes`. The caller persists that returned set as-is and must not record the same failure again: doing both would
count one failure twice. Carry the returned `outcomes` into the next `escalate()` and into whatever stores the counts.

## The line

One sentence from fixed templates, built from the two factors that decided the pick. Names come from `names`,
else the offer's provider and model, else its id. Money is in dollars to 3 significant figures; a percentage is a
whole number. The line never names another person, a key or a path.

For the person's own free machine the line claims only what the step asked for: `harness:tools` (the harness's own
tools, including the signed-in CLI) makes it say "your sign-in", and `harness:host-access` (the person's machine and
its files) makes it say "your files". With neither it says only "your own machine".

| Situation | Template |
|---|---|
| own free machine, sign-in and files asked for | `On your desktop: it has your Claude sign-in and your files, and it's free.` |
| own free machine, sign-in asked for | `On your desktop: it has your Claude sign-in, and it's free.` |
| own free machine, files asked for | `On your desktop: it has your files, and it's free.` |
| own free machine, neither asked for | `On your desktop: your own machine, and it's free.` |
| another machine is streaming | `On the cloud pool: your desktop is streaming, and this needs 4 cores.` |
| the cheapest that meets the bar | `On DeepSeek V4 Flash: the cheapest that meets the bar ($0.003 a try, 91% expected).` |
| hysteresis keeps the current one | `Staying on your laptop: the best alternative is only 6% better.` |
| an escalation moved it | `Moved to the cloud pool: your desktop failed this twice.` |
| nothing meets the bar | `Nothing meets the bar for code.fix; the best is MiniMax M2 at 52%. Ask before going ahead?` |

`lineFor(facts)` is exported for tests and for a caller that already has the two factors; `place()` and `escalate()`
build the facts from the result.
