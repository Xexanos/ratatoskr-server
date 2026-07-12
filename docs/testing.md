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

- **Security:** HTTPS enforced unless `ALLOW_PLAIN_HTTP=true`; the streamer token
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
  creates its own end user + streamer user (progress in ABS is per-user) and spawns its own
  compiled server. `absLive.integration.test.ts` drives the ABS-backed `/v1` endpoints
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
- **Phase 4, playback slice 1 (start / resume / stop) — present:** the **fake Sonos**
  UPnP/SOAP double (`packages/fake-sonos`), a **Sonos-control component
  test** driving the real `SonosClient` against it (`test/sonosPlayback.test.ts`, asserting
  DIDL-Lite is required, `RelTime` trusted, `TrackDuration` ignored — SPEC §4), and a
  **playback session-flow integration test**
  (`packages/integration-tests/test/sessionFlow.integration.test.ts`) that drives
  `PUT/GET/DELETE /v1/sessions/current` through the compiled server against the shared live
  ABS **and** the fake Sonos — starting a book, resuming from the ABS position, and writing
  progress back on stop. Its tests are **order-independent**: `beforeEach` clears any
  session, deletes + re-seeds the user's progress record (a finished record cannot be
  un-finished by PATCH — ABS rewinds it to 0), and resets the fake speaker. The double runs
  in-process here via `SONOS_SEED_HOST=host:port` + `SONOS_DISABLE_EVENTS=1`.
- **Lands with the later playback slices:** the continuous **sync loop** (poll → write-back)
  and the pause/resume/seek controls, then the rotation handover.
- **Set up when E2E is built:** publishing the fake Sonos as a GHCR image for the
  central E2E repo to consume.
