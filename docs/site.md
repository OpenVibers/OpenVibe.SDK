# openvibe-sdk/site

What every OpenVibe site's server was made of. The consolidation review of 2026-11-16 read all 69 repositories and
found the same files copied from site to site: new sites were made by cloning an existing one. Each piece below is one
implementation here, built from the copy most sites shared. A site passes its own name, patterns and packages.

| Here | Was | Copies |
|---|---|---|
| `createKeyStore`, `jwksUrl`, `publicReason` | `server/auth/keys.js` | 31 |
| `asyncRouter` | `server/http/router.js` | 27 |
| `linkHeader`, `linksOf` | `server/link-header.js` | 8 |
| `openapiRoute`, `routesOf`, `summariesFrom`, `mountPathOf` | `server/http/openapi-routes.js` | 8 |
| `isoTime`, `normalizeTimes`, `isoJsonTimes`, `storedTime` | `server/iso-times.js` | 5 |
| `createTwins` | `server/agent-twins.js` | 9 |

## Adopting it

Replace the site's copy with the SDK's, keeping the file and its exports for one release, so nothing that requires it
changes:

```js
// server/auth/keys.js
'use strict';
const site = require('openvibe-sdk/site');
module.exports = { createKeyStore: (o) => site.createKeyStore({ name: 'OpenVibe.Blog', ...o }), jwksUrl: site.jwksUrl };
```

```js
// server/http/router.js
'use strict';
const express = require('express');
const site = require('openvibe-sdk/site');
module.exports = { asyncRouter: () => site.asyncRouter(express.Router()) };
```

```js
// server/agent-twins.js
'use strict';
const express = require('express');
const agentLayer = require('openvibe-shared/agent-layer');
module.exports = require('openvibe-sdk/site').createTwins({ express, agentLayer, paths: /^\/(?:docs)?$/ });
```

`link-header.js`, `openapi-routes.js` and `iso-times.js` become `module.exports = require('openvibe-sdk/site');`.
Then point the callers at `openvibe-sdk/site` and delete the file.

**Notes:**
- `asyncRouter` wraps every method (`get`, `post`, `put`, `patch`, `delete`, `all`). Some copies wrapped fewer; wrapping
  more only turns an unhandled rejection into a handled one.
- `jwksUrl` reads both config shapes: `networkInternalUrl` / `networkUrl`, and `network.internalUrl` / `network.url`.
- `iso-times` is Chat's copy, the only one with `storedTime()`.
