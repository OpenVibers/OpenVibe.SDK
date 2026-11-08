# Compute placement and provider adapters

`require('openvibe-sdk/compute')` exports `choose`, `scale`, `micros`, `charge`, and
`createProviders`. Run owns inventory, authorization, pool state, reservation transactions and
reconciliation. This module does no background work and cannot authorize spending.

`choose(request, machines, pool, {now,current})` applies ownership, trust, health, resource,
region, price and egress constraints before calling the existing `placement.plan()`.
Strategies: `cheapest`, `fastest`, `private`, `own`, `automatic`. Automatic walks own,
home, dedicated, community, partner, skipping tiers with unavailable capacity, excessive
queue wait, unhealthy machines or costs above the ceiling. `current` provides price
hysteresis; a hard failure switches immediately. Decisions include price, tier and reasons.
Only trusted operator inventory may assign a tier; a public offer cannot claim to be private.
Currency must match; this module never guesses exchange rates. Home public egress requires
`ovh-tunnel`. Own machines must match the authenticated requester.

`scale(pool,machines,waiting,{now})` returns provision/drain/release actions. Capacity uses
the larger of measured peak RAM and 300 MB/browser or 2048 MB/desktop, plus host-reported
free slots. The inventory must subtract OS RAM. A draining machine cannot accept placements;
release waits for authoritative zero sessions. Missing observations are not zero sessions.

Providers implement `quote`, `provision`, `health`, `release`, with normalized hourly price,
currency, RAM/GPU, billing quantum and quote expiry. All network calls use a deadline, reject
redirects, and keep credentials out of URLs and errors. Provision requires a key, but the caller
MUST also reserve the entire rental against an owner-set cap before calling it.

Sources (checked 2026-11-08):
- [Hetzner Cloud](https://docs.hetzner.cloud/reference/cloud): authenticated server types and server lifecycle.
- [Hetzner Robot](https://robot.hetzner.com/doc/webservice/en.html): auction purchases have separate cancellation terms.
- [OVH schema](https://api.ovh.com/1.0/cloud.json): public pricing plus authenticated project flavors and instance lifecycle.
- [Vast API](https://vast.ai/developers/api): public offers, PUT to rent, instance lifecycle.
- [RunPod schema](https://raw.githubusercontent.com/runpod/docs/main/api-reference/openapi.json): REST v1 pods; GraphQL GPU catalogue.

No-key reads: Hetzner auction, Vast offers, RunPod GPU prices, community offers, subject to
provider rate limits/access policy. Cloud requires its token; OVH needs project credentials
to associate catalogue prices with usable flavors. An unavailable API is not a free quote.
Auction purchase is deliberately disabled until setup fees and cancellation liability can be
reserved. Community inference offers are token-priced and cannot be treated as hourly machine
rentals; use AI's existing router or lease an existing desk through Bot. Neither adapter
pretends to support machine purchases. Quotes exclude variable disk/egress charges; callers
must reject provisioning unless those costs are bounded separately. GPU runtimes belong to AI.
