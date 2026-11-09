# Design component registry

OpenVibe.Design publishes platform-neutral `design.component@1` definitions. Each definition gives the component's anatomy, props, states, tokens, behavior, accessibility, a web module and demo, and Android and iOS specifications.

```js
const { design } = require('openvibe-sdk');
const d = design.createDesignClient();               // the registry is public: no token
const { components } = await d.components();
const sheet = await d.component('sheet');            // null when no component has that name
```

The same client draws and finds icons when it has a token
(`design.createDesignClient({ accessToken })`, see [design-icons.md](design-icons.md)); without one, `icons.*` throws
before any request.

The public endpoints are `GET /api/v1/components` and `GET /api/v1/components/:name`. A missing name returns `null` in the SDK. The API also carries the older kit document specs under `kitComponents` for clients that render kit documents.
