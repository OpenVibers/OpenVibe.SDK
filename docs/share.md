# Network-wide sharing (Node)

`openvibe-sdk/share` implements the 2026-11-06 sharing design in each service's PostgreSQL database. The service is the authority. The module never reads titles, content or media URLs. Contracts is temporarily pinned to `feat/sharing-core-contracts` (0.291.0), pending the orchestrator's release and repin. Both core PRs require Opus's line-by-line security review before adoption.

```js
const { createShares, sharesSchema, shareOpenApi } = require('openvibe-sdk/share');
const shares = createShares({
    db,                         // openvibe-sdk/db; PostgreSQL in production, PGlite in tests
    network,                    // createClient with an internal Network base URL and service token
    events,                     // createEventsClient; publishes envelopes to Events
    notify,                     // async notification => Network delivery adapter
    onOwnerChange: async (ref, from, to, tx) => { /* update this service's resource using tx */ },
    onAudienceChange: async (ref, audience, tx) => { /* update visibility and search projection using tx */ },
});
// Include sharesSchema() in an expand migration run by the migration role.
// await shares.migrate() is a convenience for tests or that same migration role.
await db.tx(async tx => {
    // Insert the resource here, then its sharing row in the same ambient transaction.
    await shares.register({ service: 'community', kind: 'paste', id }, {
        owner_subject: authenticatedSubject, audience: 'private',
    });
});
app.use(shares.router({ service: 'community', authenticate: verifiedViewer }));
```

`verifiedViewer(req)` returns `{ subject: { type, id }, staff?: true }` from verified service authentication, or `null`. A caller's body, query, forwarded header or unverified token must never set a subject or staff bit. Cookie authentication must check CSRF for mutations in this function or in earlier middleware. Authentication precedes dispatch. The router supports Node HTTP and Express (mount at the root so it sees `/api/v1/...`); JSON bodies are capped at 64 KiB. Services still authorize their own resource read/edit routes.

The migration creates `shares`, `share_members`, `share_transfers`, `share_access_requests`, and `share_log`; supporting tables `share_deliveries` and `share_name_limits` persist deliveries and lookup budgets. It only creates tables, indexes and the append-only log guard; no table/column is dropped. Runtime reads/writes need normal DML permissions, while migration DDL runs separately. Grant runtime INSERT/SELECT on `share_log`, with no DDL privilege. Its trigger also rejects UPDATE, DELETE and TRUNCATE. The helper is repeatable.

| Server method | Result |
| --- | --- |
| `register(ref, { owner_subject, audience = 'private' })` | Share; trusted service-only initialization, never an HTTP operation |
| `canView(viewer, ref)`, `canEdit(viewer, ref)` | boolean; missing resources deny |
| `get(viewer, ref)` | owner/staff share settings |
| `getWithRevision(viewer, ref)` | `{ value: Share, etag }` |
| `setAudience(viewer, ref, audience)` | Share |
| `addMembers(viewer, ref, ['@name' \| subject \| { name \| subject, role, expires_at? }])` | Share; exact names or canonical subjects |
| `removeMember(viewer, ref, subject)` | Share |
| `update(viewer, ref, { audience?, members? }, { ifMatch? }?)` | Share; atomically replaces members when provided |
| `requestAccess(viewer, ref)` | AccessRequest; deduplicated pending request and owner notification |
| `transfer(viewer, ref, { to: '@name' \| subject, keep_access = false })` | Transfer |
| `accept(viewer, ref, transferId)`, `decline(...)`, `cancel(...)` | Transfer |
| `sharedWithMe(viewer, { service?, limit = 50, cursor? }?)` | `{ items, next_cursor }`; ids and access metadata only |
| `expireMembers({ limit = 100 }?)` | number of resources swept, including expired transfers |
| `flush({ limit = 100 }?)` | number of durable deliveries sent |
| `router({ service, authenticate })` | Node/Express middleware |

`ref` is `{ service, kind, id }`. Subjects follow `identity.subject-ref@1`; the common user case is `{ type: 'user', id: 'usr_<ULID>' }`. A bare subject-id string is never an identity projection. Expiry timestamps are absolute RFC3339 timestamps in the future. Viewer/editor membership is effective for **people** only. Public/link grant viewing to everyone but never grant editing to strangers; private is owner-only. Active pending transfer recipients may preview in every audience. Staff view/edit overrides append audit records even on public resources; staff cannot start/accept/decline another person's transfer. Owners and trusted staff may manage share settings. Generic 404 responses reveal no resource title or existence through share settings.

The resource lock serializes ACL changes, transfer answers and access checks. To make an edit and its check indivisible, call `canEdit` and write the resource in one `db.tx` (ambient mode enabled). Transfer acceptance changes owner, membership and history together, with outgoing and incoming audit entries. An old/forwarded notification cannot accept a new offer: every answer requires its transfer id, exact recipient subject, pending state and a future expiry. Cancel is owner-only. Expiry is enforced in read/action predicates even before the sweep runs. `keep_access: true` retains only viewer membership; if the resource was private, it becomes people to make that viewer access effective. With `false`, the old owner's membership is removed. Public/link resources retain their inherent anonymous viewing.

Hooks run **inside** the database transaction and may run again if the database retries it. Use the provided `tx` to update the local resource, local media proxy authorization state and local search projection, or to queue an external media/search operation in a transactional service outbox. Do not perform irreversible network calls in these hooks. A hook error rolls everything back. Restrict access at the service immediately; media objects must already be private and proxied by the service before enabling people/private sharing.

Every read surface must call `canView`: HTML, raw/download, API, embeds, media proxies, comments and previews. That check alone is not permission to publish/index content: only `audience === 'public'` may go to search, sitemaps or content previews/events. People/private resources must never be embedded, even for an authenticated owner. Return generic cards for other audiences, and never expose a media object's direct URL. This core package does not modify service endpoints; pilot adoption is a separate change.

Names use `GET /internal/identity/resolve?username=<exact name>` and check the response's `subject` object, matching username and banned flag. There is no prefix/global search. Configure the Network client with the internal base URL and `identity.subject.resolve` service token. Defaults are 30 name checks per caller per 60-second window (`nameLimit`, `nameWindowMs`); counters are atomic and shared across SDK instances using this database. Unknown/banned names consume the same budget. The batch limit is 100 members; PUT and add both enforce it. If multiple entries resolve to the same subject, the last entry wins (so an agent adding an existing @name updates its role). Only an already-authorized owner/staff caller reaches name resolution. Suggestions belong to Network's per-person sharing history.

Name-based mutations must run outside a caller-created ambient transaction so a rollback cannot refund name-check attempts; the module opens its own mutation transaction and hooks still join it. Canonical-subject operations may join a service transaction. Schedule `expireMembers()` and `flush()` in the service worker. `flush()` refuses an ambient transaction to prevent sending uncommitted deliveries. Access expiry never depends on worker timing. Writes only enqueue deliveries; notifications/events are asynchronous and become visible after `flush`. Pending deliveries survive process restart and are sent in insertion order. A failed send remains pending and stops that flush; retry with bounded worker backoff. Delivery is at least once: Events deduplicates the stable `event_id`, and the notification adapter must deduplicate `delivery_id`. The injected `notify` function is called with `{ kind, to, actor, ref, delivery_id, ...accessMetadata }`; pass it to Network's authenticated notification route. Grant/revoke changes use `share.added` with an action for revocation/audience updates; transfer results use `share.transfer.answered`. No title/content is stored in these records. A service can enrich a direct notification only after checking the recipient's current access.

The five Events payloads are `share.granted`, `share.revoked`, `share.transfer.requested`, `share.transfer.accepted`, `share.transfer.declined`. All audiences carry ids and ACL metadata only. Payload `ref.service` and envelope `source` identify the adopting service. Declare these produced types in its service manifest when adopting. Audience updates include the new audience; cancellation/expiry emit revocation of the preview grant, and acceptance includes both subjects. Grant/revoke payloads carry `reason` (member_added, member_removed, member_expired, audience_changed, transfer_cancelled, transfer_expired, ownership_changed) and the relevant `transfer_id`. Event consumers must combine audience, membership and transfer state; a revoked preview is not deletion of an independent membership. Network's aggregated list must recheck local access before disclosing content.

The uniform routes and request/response schemas are exposed by `shareOpenApi()` (OpenAPI 3.1); merge its `paths` and bearer security scheme into the service document. The exact routes are GET/PUT `/api/v1/{kind}/{id}/share`, POST `.../share/requests`, POST `.../share/transfer`, POST `.../share/transfer/{accept,decline,cancel}`, and GET `/api/v1/shared-with-me`. GET settings returns an ETag; PUT supports If-Match and returns 412 on a stale revision. Transfer answers take `{ transfer_id }`. HTTP errors use `{ code, error: message }`, which the SDK core maps to typed errors; unknown server errors are a generic 500.

```js
const sdk = require('openvibe-sdk');
const item = sdk.share({ base: 'https://community.openvibe.network', token }).for('paste', id);
await item.setAudience('people');
await item.add('@maticus', { role: 'viewer' });
const offer = await item.transfer('@maticus');
// Signed in as that exact recipient:
await recipientItem.accept(offer.id);
```

The client also has `get`, `update`, `remove(subject)`, `requestAccess`, `decline(id)`, `cancel(id)`, and service-level `sharedWithMe`. Member additions/removals read the ETag and send a conditional PUT, so they fail visibly on concurrent ACL changes. Network failures on mutations are not automatically retried. Read again to determine the result before retrying. Server CJS, ESM and TypeScript are exported from `openvibe-sdk/share`; the browser export is disabled.

Run `node test/share.test.js` for the database and HTTP security suite. It covers all audience/role combinations, hidden 404s, expiration, audited staff access, exact-name resolution/rate limits, owner notification, all transfer answers, keep_access, forwarded offers, concurrency, hook rollback, immutable audit, durable retry, schemas and the agent client against a real local HTTP server.
