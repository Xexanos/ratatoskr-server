# Testing — ratatoskr-server

> Repo-local test strategy for the Ratatoskr **server** (the bridge). The
> overarching, cross-component strategy — including end-to-end tests across the
> app, server, Audiobookshelf and a fake Sonos — is defined centrally:
> → [ratatoskr-e2e/test-concept.md](https://github.com/Xexanos/ratatoskr-e2e/blob/main/test-concept.md)
>
> This describes the **target** strategy; where the current code does not yet
> match, see [Status](#status--alignment).

## Scope

The server is the bridge between Audiobookshelf (ABS) and Sonos speakers — audio
never flows through it; it issues control commands and syncs progress. Everything
here tests the **server in isolation** (alone or against simulated neighbors).
Tests that exercise the real app + server + ABS + Sonos together are **E2E** and
live in the central repo, not here.

## Levels

Runner: **Vitest** (TypeScript/ESM-native).

### Unit — pure logic, no I/O
- position mapping (absolute seconds ↔ track index + offset) — the mandatory cases in
  [`SPEC.md §9`](./SPEC.md) (single- and multi-file books, seeking across a track boundary,
  the start and the very end, rounding at track edges) are the non-negotiable minimum here
- DIDL-Lite metadata building for the transport URI
- config / environment validation
- log redaction (no secret ever reaches a log line)
- token-rotation bookkeeping
- seek tolerance / settle math

### Component — one subsystem against a simulated neighbor
- **ABS client** against a **fake ABS** HTTP server: login / refresh, library
  projection, progress read/write.
- **Sonos control** against the **fake Sonos** (see [Fakes](#the-fakes)):
  `SetAVTransportURI`, `Play`/`Pause`/`Seek`, `GetPositionInfo`/`GetTransportInfo`;
  asserts the DIDL-Lite requirement and that `RelTime` is trusted while the
  reported track duration is not.
- **API layer** (Fastify routes) against mocked ABS + Sonos: request → response
  mapping, error mapping, status codes.

### Integration — the whole server against fakes
Spawn the built server and drive its `/v1` API end to end against the fake ABS and
fake Sonos, including the sync loop (poll position → write progress back to ABS).

## Cross-cutting types

- **Security:** HTTPS enforced unless `ALLOW_PLAIN_HTTP=true`; the streamer API key
  appears only in the media URLs handed to speakers; secrets never appear in logs
  (redaction); bearer auth + refresh-token rotation.
- **Contract runtime-conformance:** the running server's responses are validated
  against `contract/openapi.yaml` (Ajv / response validation), and CI runs
  `oasdiff` against the previous contract to fail on unflagged breaking changes.
  There is deliberately **no separate contract-test level** — both sides generate
  from the shared spec, so the type contract holds by construction (see the
  central concept, §3).

## The fakes

- **Fake ABS** — a small HTTP server standing in for Audiobookshelf in component
  and integration tests.
- **Fake Sonos** — a stateful local-UPnP/SOAP double for a speaker, **owned by
  this repo** as its own workspace package (`packages/fake-sonos`,
  `@ratatoskr/fake-sonos`). It runs in **two modes**: imported **in-process** by
  the component and integration tests, and built as a **container image** (the
  package carries the Dockerfile and standalone entrypoint; publishing to GHCR
  lands with the E2E work) that the central E2E repo pulls, pinned by digest. One
  behavioral definition, so the server's component tests and the E2E stack can
  never drift apart. It reproduces the real quirks recorded in
  [`SPEC.md §4`](./SPEC.md): DIDL-Lite metadata is required, `TrackDuration` is
  unreliable, `RelTime` is authoritative.

## Running

```sh
pnpm test              # unit + component
pnpm test:integration  # integration against the fakes
pnpm lint
```

## Status / alignment

The strategy above is the target. Current state:

- **Present:** unit tests; a process-level integration smoke test (config validation and
  `/health` against a trivial fake ABS, no Docker); and **live-Audiobookshelf integration
  tests** in their own workspace package (`packages/integration-tests`). One real
  Audiobookshelf container (Testcontainers) is booted and seeded **once per run** in a
  Vitest `globalSetup` (root user, a book library with a fixture audiobook, forced scan);
  the connection info reaches the test files via `provide()`/`inject()`. **Isolation on the
  shared container is per-file ABS users**: root is seeding-only, and every test file
  creates its own end user + a stream-only streamer account whose ABS API key it embeds in the
  media URLs (progress in ABS is per-user) and spawns its own compiled server. `absLive.integration.test.ts` drives the ABS-backed `/v1` endpoints
  (auth login/refresh, library list/detail) with Ajv contract-conformance. **Version
  coverage lives in CI:** the `integration` job is a two-leg blocking matrix — the pinned
  2.26.0 minimum and the deliberately **unpinned `:latest`** tag as a drift canary for new
  ABS releases — selected via `ABS_IT_IMAGE`; locally the default is the pinned current
  digest. The suite is Docker-gated in `globalSetup`: local runs with no container runtime
  skip the live files cleanly (the smoke test still runs), but in CI (or with
  `ABS_IT_REQUIRE=1`) a missing runtime **fails** the run instead of skipping, so live
  coverage can never silently disappear while CI stays green. 90% coverage thresholds; the
  `oasdiff` breaking-change gate in CI. (The ABS client is also exercised as a unit test via
  a stubbed `fetch`; the component-level fake-ABS *HTTP* server described above still lands
  with the fuller component suite.)
- **Phase 4, playback slices 1–2 (start / resume / stop / pause / resume / seek + sync loop) —
  present:** the **fake Sonos** UPnP/SOAP double (`packages/fake-sonos`), a
  **Sonos-control component test** driving the real `SonosClient` against it
  (`test/sonosPlayback.test.ts`, asserting DIDL-Lite is required, `RelTime` trusted,
  `TrackDuration` ignored — SPEC §4, plus pause/resume), **session-manager unit tests**
  (`test/sessionManager.test.ts`) covering the sync loop's write-back threshold, finished
  detection, and device-side stop/pause reactions with fake timers, and a **playback
  session-flow integration test** (`packages/integration-tests/test/sessionFlow.integration.test.ts`)
  that drives `PUT/GET/POST(pause|resume|seek)/DELETE /v1/sessions/current` through the compiled
  server against the shared live ABS **and** the fake Sonos — starting a book, resuming from
  the ABS position, pausing/resuming/seeking, observing the background sync loop write a
  **device-side** pause's position back to ABS, and writing progress back on stop. Its tests
  run as one **session-lifecycle sequence** (each builds on the previous test's state); the
  cross-file isolation on the shared container comes from this file's own ABS users, not from
  per-test resets. The double runs in-process here via `SONOS_SEED_HOST=host:port` +
  `SONOS_DISABLE_EVENTS=1`.
- **Phase 4, playback slice 3 (token rotation / shutdown / streamer identity) — present:** the
  **token-rotation handover** (§8) — unit-tested with fake timers + fake JWTs (renew-before-expiry,
  owner-gated redelivery until adoption, the `stopSession` 200/204 split); **graceful shutdown**
  (§5) — an integration test SIGTERMs the spawned server and asserts the reached position was
  written (Linux-only, so CI exercises it); and the **stream-only ABS API key** in media URLs (§14)
  — the session-flow integration test fetches the enqueued media URL from real ABS to prove the key
  streams as `?token=` on every supported ABS version.
- **Server container image — present:** a single multi-stage, multi-arch
  [`Dockerfile`](../Dockerfile) and a `container.yml` workflow publish the server to GHCR as
  `ghcr.io/xexanos/ratatoskr-server:testing-<sha>` for the central E2E repo to consume; a
  separate `promote.yml` re-tags a *tested* digest (no rebuild) to a release channel after E2E
  passes. The full flow is documented in [`docs/deploy.md`](./deploy.md).
- **Fake Sonos image — present:** the same `container.yml` also builds
  `packages/fake-sonos` and publishes it to GHCR as `ghcr.io/xexanos/ratatoskr-fake-sonos`
  with the same `testing-<sha>` / `sha-<sha>` tags, so the central E2E repo pulls the fake
  that matches the exact server commit under test.
