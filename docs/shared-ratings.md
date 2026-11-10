# Shared Bench ratings

```js
const { createClient } = require('openvibe-sdk/core');
const { createBenchClient } = require('openvibe-sdk/bench');
const bench = createBenchClient(createClient(), { baseUrl: 'https://bench.openvibe.services' });
const { board } = await bench.ratings.get('design.page', { category: 'all' });
```

This browser-safe GET sends no token or acting subject. It uses Bench's fitted
rating, confidence and rank intervals. Models with fewer than twenty eligible
games are omitted, including their counts. An empty board is insufficient
evidence, not a score. `signal` is accepted for cancellation.

Use `subject` as the model identity and keep kind/category with the rating.
Do not average ratings across different kinds, model revisions or categories.
Combine these quality observations with `ai.metrics` for receipt-based speed and
cost; those measures have their own twenty-observation floor.
