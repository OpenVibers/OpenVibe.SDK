# What 1.0 freezes

1.0 freezes five entries first: `core`, `auth`, `events`, `db` and `media` ([README, "Versioning"](../README.md#versioning)).
Inside them, a name is in one of three tiers. [one-point-oh.json](one-point-oh.json) holds the lists, and
`test/surface.test.js` fails when a name in those entries has no tier. `node scripts/surface.js --check` marks a
breaking change with the tier of the name it breaks.

| Tier | Meaning |
|---|---|
| **frozen** | Semver from 1.0: removing it or changing its kind or shape needs a major release. This is what an app or a service written outside OpenVibe builds on: signing in, verifying tokens, calling the API, events in and out, PostgreSQL, media. |
| **platform** | Exported, and OpenVibe's own services use it, but not frozen: its shape follows the platform, such as storage schemas, trace propagation and key handling a service needs only inside OpenVibe. It may change in a minor release, and CHANGELOG.md says so. |
| **leaving** | Deprecated now and gone in 1.0. Each has a replacement already in the frozen tier. |

Usage is counted from every OpenVibers repository's `main` on 2026-10-23 (repositories other than the SDK that
import the entry and name the export). A count of 0 does not mean leaving: much of the frozen tier exists for
developers outside the organisation, who are not in the count.

## core

- **frozen:**
  - `createClient` (21 repositories);
  - `OpenVibeError` (4) and `isOpenVibeError` (2);
  - `paginate` and `offsetPager` (list pages for app code);
  - `ulid`, `newIdempotencyKey`, `compareVersions`, `satisfiesRange`;
  - `SDK_VERSION`, `DEFAULT_NETWORK`, `CONTRACTS_RANGE`.
- **platform:**
  - `startSpan`, `parseTraceparent` and `contextFromHeaders`: the platform's trace propagation, with 0 users outside the SDK. Its header format may still follow OpenTelemetry changes.
  - `isActingSubjectId`: identity internals.
  - `newEventId`: producers inside the platform. Apps publish through `createAppEvents`, which makes the id.

## auth

- **frozen:**
  - sign-in for an app: `buildAuthorizeUrl`, `startAuthorization`, `readCallback`, `exchangeCode`, `refreshUserToken`, `createPkcePair`, `createState`;
  - verification on a server: `verifyUserToken` (31), `verifyServiceToken` (36), `verifyAppToken` (13), `jwksClient` (23), `jwksStatus` (17);
  - `createServiceTokenClient` (22);
  - display only: `decodeUnverified`, `unverifiedClaims`.
- **platform:**
  - `createPgRevocationStore`, `revocationSchema` and `TOKEN_VALID_AFTER`: storage for Network's revocation events, on the platform's schema;
  - `createNetworkKeys` (12): service key handling;
  - `createJwksClient`: the uncached constructor behind `jwksClient`, which is what code should call;
  - `base64url`: an encoding helper, not an auth API.
- **leaving:** `createCodeVerifier` and `pkceChallenge`. They are the two halves of `createPkcePair`, and no repository uses them.

## events

- **frozen:**
  - `createEventsClient` (11), `createAppEvents`, `appSource`, `projectKey`;
  - receiving: `parseDelivery` (15), `verifyDeliveryV2`;
  - signing in tests and senders: `signDeliveryHeaders`, `signDeliveryV2`.
- **platform:** `createPgOutbox`, `createServiceOutbox`, `createPgInbox`, `outboxSchema`, `inboxSchema`. They are the PostgreSQL outbox and inbox a service keeps beside its own tables. Their schema and relay behaviour change with the platform; 0.63.0 added a 429 pause and pruning.
- **leaving:** `signDelivery` and `verifyDelivery`, the v1 signature.
  - v1 signs no time, so a captured delivery verifies forever.
  - OpenVibe.Events sends only v2 (`X-OpenVibe-Signature-V2`, over the timestamp and the body, within five minutes).
  - Every production receiver already calls `parseDelivery(..., { requireV2: true })`.
  - From 0.64.0, `parseDelivery` requires v2 by default. `{ requireV2: false }` still accepts v1, deprecated.

## db and media

All frozen:
- `createDb` (42), `sql` (43), `DbError`, `ISOLATION`, `PARSERS`;
- `createMediaClient`, `createObjectsClient`, `mediaUrls`, `DEFAULT_PUBLIC_ORIGIN`.

## Before 1.0

1. The leaving names go: remove them, update `docs/api-surface.json`, and the test lists them as breaking.
2. Publish to npm (owner's account), so that `npm i openvibe-sdk` works without a tarball pin.
3. From then on, a breaking change marked `[1.0 core]` needs a major release.
