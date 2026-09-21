# OpenVibe.SDK

> Supported browser and server clients for the OpenVibe platform.

**Status:** placeholder — planning only, no runnable code yet.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §3.2.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Typed clients generated from OpenVibe.Contracts plus hand-written behaviour for auth, retries, idempotency, pagination, realtime and trace propagation, so no consumer has to know internal route layouts.

## Owns

- `@openvibe/sdk-core|auth|registry|events|realtime|media|chat|community|live|billing|games|jobs` packages
- version negotiation and feature detection
- mock/local adapters for development

## Does not own

- service implementations
- UI components (see OpenVibe.Shared)

## Planned surfaces

- separate browser and server entry points, tree-shakeable
- deadline/timeouts, retry only where semantics allow, `Idempotency-Key` helper
- typed cursors/pagination and standard errors
- automatic `traceparent` propagation

## Data (authority tables / families)

- none (artifact repository)

## Capabilities and events

- typed wrappers for every public capability

Events: n/a

## Depends on

- OpenVibe.Contracts
- OpenVibe.Network (OAuth2/OIDC, service principals)

## Acceptance (must be true before "done")

- an external example app authenticates, discovers Media from the registry and uploads an object with only the SDK and a capability grant
- no secret-bearing code ships in browser bundles

## Bootstrap / extraction source

Replaces the hand-written per-repo clients (Live's `media-client`, Community's proxies, Tools' fetch helpers).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
