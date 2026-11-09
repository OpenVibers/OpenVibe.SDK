# Design component registry

OpenVibe.Design publishes platform-neutral `design.component@1` definitions. Each definition gives the component's anatomy, props, states, tokens, behavior, accessibility, a web module and demo, and Android and iOS specifications.

```js
const { createClient, design } = require('openvibe-sdk');
const ov = { design: design.createDesignClient(createClient({ baseUrls: { design: 'https://openvibe.design' } })) };
const { components } = await ov.design.components();
const sheet = await ov.design.component('sheet');
```

The public endpoints are `GET /api/v1/components` and `GET /api/v1/components/:name`. A missing name returns `null` in the SDK. The API also carries the older kit document specs under `kitComponents` for clients that render kit documents.
