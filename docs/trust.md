# Trust signals

`openvibe-sdk/trust` reads the privacy-limited trust signals served by OpenVibe.Network. Pass a `getToken` callback so
tokens can be refreshed without storing credentials in the client:

```js
import { createTrustClient, isNew, atLeast } from 'openvibe-sdk/trust';

const trust = createTrustClient({ networkUrl: 'https://openvibe.network', getToken });
const mine = await trust.me(); // account or guest's own token
const other = await trust.of('gst_01JAB2C3D4E5F6G7H8J9K0MNP1'); // requires identity.trust.read

if (isNew(other, { hours: 24 })) { /* apply a stricter abuse policy */ }
if (atLeast(mine, 'under_7d')) { /* account or guest is at least one day old */ }
```

`AGE_BANDS` orders bands from youngest (`under_1h`) to oldest (`30d_plus`). `isNew` uses whole age hours and `atLeast`
compares the coarse band. Trust payloads never contain IPs, emails, last-seen timestamps, service user ids, or linked
account identities; same-network activity is only an aggregate count. These signals do not replace authorization.
