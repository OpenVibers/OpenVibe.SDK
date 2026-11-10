# Measured model metrics

`ai.metrics` works in browser and server clients and never requests credentials.

```js
const { createClient } = require('openvibe-sdk/core');
const { createAiClient } = require('openvibe-sdk/ai');
const ai = createAiClient(createClient(), { baseUrl: 'https://api.openvibe.exchange' });
const comparison = await ai.metrics.compare({
  models: ['openai/gpt-5-nano', 'openai/gpt-5-mini'],
  kind: 'chat', measures: ['latency_p50_ms', 'cost_per_run_usd'],
});
const series = await ai.metrics.model('openai/gpt-5-mini', { days: 90 });
const board = await ai.metrics.leaderboard({ kind: 'chat', measure: 'latency_p50_ms' });
const prices = await ai.metrics.prices('openai/gpt-5-mini', { days: 30 });
const health = await ai.metrics.providerHealth('openai');
```

Comparisons and leaderboards use the same completed UTC day for every model and
keep provider and task kind separate. The response supplies that day, sample counts
and methodology. Model series cover 30 or 90 days; historical gaps remain empty.
Measured cells and individual timing measures need twenty observations. Null means
unmeasured, not zero. Listed price history starts when daily catalogue capture was
deployed. Hourly provider health spans seven days. These reads perform no model call.

Pass `{ signal }` as the last argument to cancel a read. Results are cached at the
service for sixty seconds. Browsers can read the public CORS-enabled endpoints.
