# Public user card

```js
import { createClient, userCard } from 'openvibe-sdk';
const cards = userCard.createUserCardClient(createClient());
const controller = new AbortController();
const person = await cards.get('Example', { signal: controller.signal });
// Or: import { createUserCardClient } from 'openvibe-sdk/user-card';
```

The browser bundle exports the same `userCard` namespace. `get()` makes one public `GET /api/v1/people/:username/card` on Network; it sends neither Bearer credentials nor cookies, even when the core client has them configured. Usernames are 3–24 letters, digits or underscores. Standard SDK deadlines, cancellation and errors apply; the owner switch being off returns HTTP 503 `user_card.disabled`.

`UserCard` always has `username` and `profile_url`. The optional fields are `display_name`, `avatar_url`, `channel_url`, `level`, `streak`, `badges_count`, `followers`, `active_sites: {id,name,url}[]`, and `live: {now:false} | {now:true,site:'live',url}`. Network owns the global level; Quest supplies daily streak and badge count. A field omitted for privacy or an unavailable source remains absent. Never turn an absent count into zero or absent live state into offline.

Network caches the aggregate for 30 seconds, coalesces concurrent misses and rechecks privacy/account eligibility before cache use. HTTP responses use `no-store`; this SDK adds no cache. Weekly sites need the person's opt-in and expose site names only from the last seven days of Network history.

Next for the design (For Fable): Shared's `OVUser.card` consumes this shape; visual presentation and the visibility controls are a separate task.
