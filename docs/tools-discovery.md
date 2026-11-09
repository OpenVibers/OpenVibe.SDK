# Tool discovery

```js
const rising = await ov.tools.trending({ window: 'hour', limit: 12 });
const popular = await ov.tools.popular({ limit: 12 });
```

`trending()` defaults to `window: 'week'`. Limits are integers from 1 to 50; both methods accept an AbortSignal. Registry reads are anonymous by default, just like `tools.list()`.

Both return `{ metric: 'successful_api_runs', window, updated_at, uses_today, tools, count }`. Each tool has `id`, `name`, `description`, `family`, `icon`, `url` and `uses`. Trending entries also have `previous_uses` and `increase`; only rising tools appear, ordered by absolute increase, use count and ID. Empty lists mean no recorded activity, while unavailable data rejects the request.

Counts cover successful inline API requests (including cache hits but excluding idempotent replays) and successful file jobs with tool IDs. They exclude page opens, browser-only edits and failures. The current UTC hour is partial; week means the last 168 hourly buckets compared with the preceding 168. The server refreshes totals every minute. No historical use is fabricated before the counter migration.

Requires the Tools gateway discovery API deployment. SDK releases follow the normal merge/tag process; this addition needs no new browser bundle entrypoint.
