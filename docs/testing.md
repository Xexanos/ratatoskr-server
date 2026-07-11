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
  this repo**. It runs in **two modes**: imported **in-process** by the component
  tests here, and built as a **container image** (published to GHCR) that the
  central E2E repo pulls, pinned by digest. One behavioral definition, so the
  server's component tests and the E2E stack can never drift apart. It reproduces
  the real quirks recorded in [`SPEC.md §4`](./SPEC.md): DIDL-Lite metadata is
  required, `TrackDuration` is unreliable, `RelTime` is authoritative.

## Running

```sh
pnpm test              # unit + component
pnpm test:integration  # integration against the fakes
pnpm lint
```

## Status / alignment

The strategy above is the target. Current state:

- **Present:** unit tests; a process-level integration smoke test (config validation and
  `/health` against a trivial fake ABS, no Docker); and a **live-Audiobookshelf integration
  test** (`packages/app/test-integration/absLive.integration.test.ts`) that boots a real,
  digest-pinned Audiobookshelf in a container (Testcontainers), seeds it (root user, a book
  library with a fixture audiobook, streamer user), spawns the compiled server against it,
  and drives the ABS-backed `/v1` endpoints (auth login/refresh, library list/detail) with
  Ajv contract-conformance. It is Docker-gated: local runs with no container runtime skip
  cleanly, but in CI (or with `ABS_IT_REQUIRE=1`) a missing runtime **fails** the test instead
  of skipping, so live coverage can never silently disappear while CI stays green. It runs in
  CI's `build-test` job. 90% coverage thresholds; the `oasdiff`
  breaking-change gate in CI. (The ABS client is also exercised as a unit test via a stubbed
  `fetch`; the component-level fake-ABS *HTTP* server described above still lands with the
  fuller component suite.)
- **Lands with Sonos support (SPEC phase 4):** the Sonos-control component tests,
  the full integration test (incl. the sync loop), and the fake Sonos itself.
- **Set up when E2E is built:** publishing the fake Sonos as a GHCR image for the
  central E2E repo to consume.
