# AGENTS.md — OpenVibe.SDK

## Project overview

The one supported way for any app — first-party service or an outside developer — to call the
OpenVibe network. This repository is the npm package `openvibe-sdk` (MIT), a dependency-free
JavaScript/TypeScript client library, not a service: it owns no database, no port and no deploy.

- **Entry points:** `index.js` (Node, CommonJS), `browser.js` (browser-safe), `esm/*.mjs` (generated
  ESM shims for every subpath), `types/*.d.ts`, and `browser/openvibe-sdk.mjs` (one self-contained
  browser bundle, checked in).
- **Source:** one module or directory per capability under `src/` (`src/core/`, `src/auth/`,
  `src/db/`, `src/service/`, `src/events.js`, `src/valkey.js`, `src/media.js`, `src/community.js`,
  `src/chat.js`, `src/ai.js`, `src/tools.js`, …), each exposing a `create*Client` factory.
- **Contract types:** `openvibe-contracts` is a dev dependency used by the tests; at runtime the SDK
  copies the types and shapes it needs, so consumers install the SDK alone.
- **Docs:** `README.md` is the API reference, `docs/` holds capability guides
  (`docs/service.md`, `docs/consent.md`, `docs/tools-routing.md`, `docs/identity-emails.md`, …),
  `docs/api-surface.json` is the generated export inventory and `docs/one-point-oh.*` the 1.0
  freeze plan.
- **CLI:** `bin/openvibe-download.js` installs as the `openvibe-download` command.

## Who calls it, what it calls

Every OpenVibe service pins a released SDK tag
(`"openvibe-sdk": "https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/vX.Y.Z"`)
and calls services only through it. The rule in `README.md` is binding: **if a capability is not in
the SDK, it is not public** — a route with no SDK wrapper is internal and may change without notice.
To make something public, define it in OpenVibe.Contracts first, then wrap it here.

The SDK never talks to a database or to another SDK module directly; each client takes a
`createClient()` and calls one service's documented HTTP API: Network (auth, identity, registry,
projects, user cards), Events, Media, Community, Chat, AI, Tools, Search, Bench, Vision, Live,
OpenRestream, Inventory, Tips, Blog, Reviews, Wiki, Coupons, Deals, Trade, Space, Host, Run, Video,
Work, Zone and VIP. `src/testing` provides `createMockPlatform()` so an app can test without the
network.

## Commands

```bash
npm ci                     # install (Node >= 20)
npm test                   # every test/*.test.js, one process each, no network
npm test -- core pack      # only files whose name contains a word
npm test -- --strict       # a skipped test fails the run
node scripts/esm.js        # regenerate esm/*.mjs from the CommonJS sources
node scripts/browser-bundle.js   # regenerate browser/openvibe-sdk.mjs (checked in; a stale bundle fails test/bundle.test.js)
node scripts/surface.js --check  # compare exports with docs/api-surface.json; exits non-zero on a 1.0-core break
node scripts/surface.js    # rewrite docs/api-surface.json after an intentional export change
node --check <file.js>     # syntax check; there is no linter
```

There is no build step for consumers and no runtime dependency: the package is plain CommonJS with
checked-in ESM and browser bundles. `npm test` uses local stub servers and `createMockPlatform()`;
it never touches the live platform.

## Conventions

- **CommonJS** (`require` / `module.exports`) in `src/`; ESM files under `esm/` are generated, never
  edited by hand.
- **4-space indent, single quotes, semicolons.** No linter or formatter is configured.
- **`create<Thing>Client` factories** take a `createClient()` (or explicit `{baseUrl, tokenClient}`)
  and return a plain object of methods. Errors are `OpenVibeError`/`ToolRunError` with a problem
  code, not bare `Error`.
- **Every subpath is an entry in `package.json` `exports`** with `types`, `import` and `default`
  (and `browser` when browser-safe). Add a capability to `index.js`, `browser.js` (if safe),
  `types/`, `esm/`, and `docs/api-surface.json`.
- **Writes are retried only when idempotent.** Either the service honours `Idempotency-Key` or the
  client does not retry (chat, live, streams and other writes are documented as never retried).
- **Deadlines, trace propagation and safe retries** live in `src/core`; use them instead of
  `fetch` + `setTimeout` by hand.
- **No secrets in code or tests.** Tokens are injected; `src/redact` is the shared scrubber.

## Key pitfalls

- **The 1.0 core surface is frozen:** `core`, `auth`, `events`, `db` and `media` cannot lose or
  rename an export without a major release. `test/surface.test.js` pins the exact lists and
  `docs/one-point-oh.json` gives each name a tier.
- **Generated files are checked in:** `esm/`, `browser/openvibe-sdk.mjs`, `types/` and
  `docs/api-surface.json` must be regenerated and committed with a source change; the tests fail on
  a stale bundle or surface. Never edit `node_modules`.
- **Browser safety:** only browser-safe modules may be added to `browser.js` or the bundle — no
  `fs`, `crypto` server APIs, `pg` or Valkey. A Node-only capability gets an `exports` entry with
  `"browser": null` (see `./app-signin`).
- **Versioning:** every release is a tag and services pin it; the changelog is `CHANGELOG.md`.
  Breaking a frozen core export, changing a problem code or a retry rule is a major-version change.
- **Consumers copy nothing:** `openvibe-sdk/no-looks` is deprecated (AI text may describe people);
  `src/explicit` is the rule for sexual content, `src/front-page` for what may lead a front page.
- **Do not add a runtime dependency.** The package is deliberately dependency-free and needs only
  Node >= 20 or a browser with `fetch`, Web Crypto and `TextDecoder`.

## Testing

`test/run.js` runs every `test/*.test.js` in its own process (240 s timeout), honours
`npm test -- <filter>`, and treats a skipped file as not passed; `--strict` makes any skip fail the
run. Files under `test/` use `assert` and local stub servers, never the live platform; `testdata/`
holds fixtures. `test/browser-entries.test.js` and `test/bundle.test.js` guard the browser surface;
`test/surface.test.js` guards the public API inventory. Run `node scripts/surface.js --check` before
committing a client change.
