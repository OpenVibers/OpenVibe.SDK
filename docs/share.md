# Network-wide sharing (Node)

`openvibe-sdk/share` implements the 2026-11-06 sharing design in each service's PostgreSQL database. The service is the authority. The module never reads titles, content or media URLs. It uses openvibe-contracts v0.291.0 (share.v1).

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
app.use(shares.router({
    service: 'community', authenticate: verifiedViewer,
    describe: async ref => ({ title, link, roles: ['viewer', 'editor'], audiences: ['public', 'link', 'people', 'private'], transferable: true }),
}));
```

`verifiedViewer(req)` returns `{ subject: { type, id }, staff?: true }` from verified service authentication, or `null`. A caller's body, query, forwarded header or unverified token must never set a subject or staff bit. Cookie authentication must check CSRF for mutations in this function or in earlier middleware. Authentication precedes dispatch. The router supports Node HTTP and Express (mount at the root so it sees `/api/v1/...`); JSON bodies are capped at 64 KiB. Services still authorize their own resource read/edit routes.

For a non-GET request without an `Authorization` header the router itself requires `X-Requested-With` (any value) or `Sec-Fetch-Site: same-origin|same-site`, otherwise it answers `403 { code: 'share.csrf' }` before authentication. Pass `csrf: false` only when `authenticate` already enforces CSRF. `describe(ref)` fills `title`, `link`, `roles`, `audiences` and `transferable`; omitted values default to `null`, `null`, `['viewer']`, all four audiences and `true`.

The migration creates `shares`, `share_members`, `share_transfers`, `share_access_requests`, and `share_log`; supporting tables `share_deliveries` and `share_name_limits` persist deliveries and lookup budgets. It only creates tables, indexes and the append-only log guard; no table/column is dropped. Runtime reads/writes need normal DML permissions, while migration DDL runs separately. Grant runtime INSERT/SELECT on `share_log`, with no DDL privilege. Its trigger also rejects UPDATE, DELETE and TRUNCATE. The helper is repeatable.

| Server method | Result |
| --- | --- |
| `register(ref, { owner_subject, audience = 'private' })` | Share; trusted service-only initialization, never an HTTP operation |
| `canView(viewer, ref)`, `canEdit(viewer, ref)` | boolean; missing resources deny. A plain snapshot: page views never take a row lock |
| `get(viewer, ref)` | the enriched share (people, `you`, pending `requests`); owner or staff. The router adds `describe()` on top |
| `getWithRevision(viewer, ref)` | `{ value: ShareView, etag }` |
| `present(viewer, ref, share)` | enrich a raw share with person projections and the caller's role |
| `lookup(viewer, '@name')` | `{ person }` or `{ person: null }`, on the same rate-limit budget as name resolution |
| `setAudience(viewer, ref, audience)` | Share |
| `addMembers(viewer, ref, ['@name' \| subject \| { name \| subject, role, expires_at? }])` | Share; exact names or canonical active user subjects |
| `removeMember(viewer, ref, subject)` | Share |
| `update(viewer, ref, { audience?, members?, notify? }, { ifMatch? }?)` | Share; atomically replaces members when provided. `notify: false` suppresses `share.added` for that save only |
| `requestAccess(viewer, ref)` | AccessRequest; deduplicated pending request and owner notification |
| `dismiss(viewer, ref, requestId)` | Share; owner sets a pending request to `dismissed` |
| `transfer(viewer, ref, { to: '@name' \| subject \| { subject } \| { name }, keep_access = false })` | Transfer |
| `accept(viewer, ref, transferId)`, `decline(...)`, `cancel(...)` | Transfer |
| `sharedWithMe(viewer, { service?, limit = 50, cursor? }?)` | `{ items, next_cursor }`; ids and access metadata only |
| `expireMembers({ limit = 100 }?)` | number of resources swept, including expired transfers |
| `flush({ limit = 100 }?)` | number of durable deliveries sent |
| `router({ service, authenticate })` | Node/Express middleware |

`ref` is `{ service, kind, id }`. Subjects follow `identity.subject-ref@1`; the common user case is `{ type: 'user', id: 'usr_<ULID>' }`. Members and transfer recipients must be active **user** subjects: a `guest`, `app`, `mod`, `agent`, `service` or `system` subject is refused, and a user subject is checked against Network (batched, cached 60 s) so unknown, banned and deleted accounts cannot be added. A bare subject-id string is never an identity projection. Expiry timestamps are absolute RFC3339 timestamps in the future. Viewer/editor membership is effective for **people** only. Public/link grant viewing to everyone but never grant editing to strangers; private is owner-only. Active pending transfer recipients may preview in every audience. Staff view/edit overrides append audit records even on public resources; staff cannot start/accept/decline another person's transfer. A staff member who is not the owner may narrow access only — set the audience to `private` and remove members — never widen, add a member or raise a role; anything else is a generic 404 like any other non-owner. Owners and trusted staff may manage share settings. Generic 404 responses reveal no resource title or existence through share settings.

The GET/PUT body names people, not subjects: `owner`, each member, the pending transfer's `to` and each pending request carry `{ subject, username, display_name, avatar_url }` from Network's `POST /internal/identity/resolve-batch` (batched, cached 60 s). A subject Network does not know (or reports banned/deleted) appears as `{ subject, username: null }`. The body also carries `you: { subject, role: 'owner' | 'staff' }`, `requests` (pending only: `id`, person fields, `requested_at`), and whatever `describe(ref)` added. `owner_subject` stays for ids-only consumers.

The resource lock serializes ACL changes, transfer answers and access checks. To make an edit and its check indivisible, call `canEdit` and write the resource in one `db.tx` (ambient mode enabled). Transfer acceptance changes owner, membership and history together, with outgoing and incoming audit entries. An old/forwarded notification cannot accept a new offer: every answer requires its transfer id, exact recipient subject, pending state and a future expiry. Cancel is owner-only. Expiry is enforced in read/action predicates even before the sweep runs. `keep_access: true` retains only viewer membership; if the resource was private, it becomes people to make that viewer access effective. With `false`, the old owner's membership is removed. Public/link resources retain their inherent anonymous viewing.

Hooks run **inside** the database transaction and may run again if the database retries it. Use the provided `tx` to update the local resource, local media proxy authorization state and local search projection, or to queue an external media/search operation in a transactional service outbox. Do not perform irreversible network calls in these hooks. A hook error rolls everything back. Restrict access at the service immediately; media objects must already be private and proxied by the service before enabling people/private sharing.

Every read surface must call `canView`: HTML, raw/download, API, embeds, media proxies, comments and previews. That check alone is not permission to publish/index content: only `audience === 'public'` may go to search, sitemaps or content previews/events. People/private resources must never be embedded, even for an authenticated owner. Return generic cards for other audiences, and never expose a media object's direct URL. This core package does not modify service endpoints; pilot adoption is a separate change.

Names use `GET /internal/identity/resolve?username=<exact name>` and check the response's `subject` object, matching the exact username case-insensitively and refusing a `banned` or `deleted` projection. Canonical subjects use `POST /internal/identity/resolve-batch` and get the same refusal. There is no prefix/global search: `lookup()` answers one exact name, and the sheet's people picker uses it. Configure the Network client with the internal base URL and `identity.subject.resolve` service token. Defaults are 30 name checks per caller per 60-second window (`nameLimit`, `nameWindowMs`); counters are atomic and shared across SDK instances using this database. Unknown, banned, deleted and failed names consume the same budget; a rate-limited lookup is `429 share.rate_limited`. The batch limit is 100 members; PUT and add both enforce it. If multiple entries resolve to the same subject, the last entry wins (so an agent adding an existing @name updates its role). Only an already-authorized owner/staff caller reaches name resolution. Suggestions belong to Network's per-person sharing history.

Name-based mutations must run outside a caller-created ambient transaction so a rollback cannot refund name-check attempts; the module opens its own mutation transaction and hooks still join it. Canonical-subject operations may join a service transaction. Schedule `expireMembers()` and `flush()` in the service worker. `flush()` refuses an ambient transaction to prevent sending uncommitted deliveries. Access expiry never depends on worker timing. Writes only enqueue deliveries; notifications/events are asynchronous and become visible after `flush`. Pending deliveries survive process restart and are sent in insertion order. A failed send remains pending and stops that flush; retry with bounded worker backoff. Delivery is at least once: Events deduplicates the stable `event_id`, and the notification adapter must deduplicate `delivery_id`. The injected `notify` function is called with `{ kind, to, actor, ref, delivery_id, ...accessMetadata }`; pass it to Network's authenticated notification route. Only these notifications exist: `share.added` to a person newly added as a member (not on a role or expiry change, and never on removal or expiry); `share.access_requested` to the owner; `share.transfer.requested` to the recipient; `share.transfer.answered` to the owner when the recipient accepts or declines or when the offer expires, and to the recipient when the owner cancels. Nobody is told about their own action, and the owner is never told about their own audience change. `notify: false` on a PUT suppresses `share.added` for that save only; events still flow. Events keep their ids-only payloads. No title/content is stored in these records. A service can enrich a direct notification only after checking the recipient's current access.

The five Events payloads are `share.granted`, `share.revoked`, `share.transfer.requested`, `share.transfer.accepted`, `share.transfer.declined`. All audiences carry ids and ACL metadata only. Payload `ref.service` and envelope `source` identify the adopting service. Declare these produced types in its service manifest when adopting. Audience updates include the new audience; cancellation/expiry emit revocation of the preview grant, and acceptance includes both subjects. Grant/revoke payloads carry `reason` (member_added, member_removed, member_expired, audience_changed, transfer_cancelled, transfer_expired, ownership_changed) and the relevant `transfer_id`. Event consumers must combine audience, membership and transfer state; a revoked preview is not deletion of an independent membership. Network's aggregated list must recheck local access before disclosing content.

The uniform routes and request/response schemas are exposed by `shareOpenApi()` (OpenAPI 3.1); merge its `paths` and bearer security scheme into the service document. The exact routes are GET/PUT `/api/v1/{kind}/{id}/share`, POST `.../share/requests`, POST `.../share/requests/{id}/dismiss`, POST `.../share/transfer`, POST `.../share/transfer/{accept,decline,cancel}`, GET `/api/v1/share/people?name=`, and GET `/api/v1/shared-with-me`. GET settings returns the GET body and an ETag; PUT supports If-Match and returns 412 on a stale revision. PUT, POST transfer, cancel, dismiss, and a recipient's accept or decline all answer with the GET body (and an ETag) so the sheet redraws from one shape; a recipient's accept or decline keeps the plain transfer shape its banner expects. Transfer answers take `{ transfer_id }`; a transfer request accepts `to` as `'@name'`, a subject object, `{ subject }` or `{ name }`. `POST .../requests` answers the access request. `GET /api/v1/share/people?name=exact` is signed-in only and answers `{ person }` or `{ person: null }`. HTTP errors use `{ code, error: message }`, which the SDK core maps to typed errors; unknown server errors are a generic 500.

```js
const sdk = require('openvibe-sdk');
const item = sdk.share({ base: 'https://community.openvibe.network', token }).for('paste', id);
await item.setAudience('people');
await item.add('@maticus', { role: 'viewer' });
const offer = await item.transfer('@maticus');
// Signed in as that exact recipient:
await recipientItem.accept(offer.transfer.id);
```

The client also has `get`, `update`, `remove(subject)`, `requestAccess`, `dismiss(requestId)`, `decline(id)`, `cancel(id)`, and service-level `sharedWithMe` and `people('@name')`. Member additions/removals read the ETag and send a conditional PUT, so they fail visibly on concurrent ACL changes. Network failures on mutations are not automatically retried. Read again to determine the result before retrying. Server CJS, ESM and TypeScript are exported from `openvibe-sdk/share`; the browser export is disabled.

Run `node test/share.test.js` for the database and HTTP security suite. It covers all audience/role combinations, hidden 404s, expiration, audited staff access, exact-name resolution/rate limits, owner notification, all transfer answers, keep_access, forwarded offers, concurrency, hook rollback, immutable audit, durable retry, schemas and the agent client against a real local HTTP server.
