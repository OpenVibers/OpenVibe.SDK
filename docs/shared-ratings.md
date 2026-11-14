# Shared ratings (Compare)

```js
const { createClient } = require('openvibe-sdk/core');
const { createCompareClient } = require('openvibe-sdk/compare');
const compare = createCompareClient(createClient());
const { board } = await compare.ratings.get('design.page', { category: 'all' });
```

The default origin is `https://openvibe.compare`, where Bench's API is mounted
(plan §X, 11-13); pass `{ baseUrl }` to point somewhere else.

This browser-safe GET sends no token or acting subject. It uses Bench's fitted
rating, confidence and rank intervals. Models with fewer than twenty eligible
games are omitted, including their counts. An empty board is insufficient
evidence, not a score. `signal` is accepted for cancellation.

Use `subject` as the model identity and keep kind/category with the rating.
Do not average ratings across different kinds, model revisions or categories.
Combine these quality observations with `ai.metrics` for receipt-based speed and
cost; those measures have their own twenty-observation floor.
