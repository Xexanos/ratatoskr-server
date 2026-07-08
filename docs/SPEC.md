# Ratatoskr server — specification and implementation brief

This document is the ground truth for implementing the Ratatoskr server. It captures
the goal, the scope of the first version, the architecture, and the decisions that
have already been made, so they do not have to be rediscovered or guessed.

Note: the technology stack and the internal module layout were intentionally left open
in the original brief. They have now been decided together with the implementing agent
and are recorded in sections 12 (Technology stack) and 13 (Module structure).

## 1. Goal

Let a user play an Audiobookshelf (ABS) audiobook on their Sonos speakers from a phone,
and keep the listening progress synchronized back into Audiobookshelf. The server is
platform independent by design, which is the whole point: it works for Android, where
AirPlay is not an option.

## 2. Scope

### In scope for v1
- Discover Sonos speakers and groups on the LAN.
- Browse and search the ABS library (thin projection; each client authenticates with its
  own Audiobookshelf identity, so the library view and progress are per-user).
- Play one audiobook at a time on one speaker or group.
- Control: start, pause, resume, seek (absolute position), stop.
- Resume from the position stored in ABS when starting.
- Write progress back to ABS periodically and on pause/stop, and mark finished.

### Explicitly out of scope for v1
- Multiroom grouping controlled from Ratatoskr (use whatever grouping Sonos already has).
- Multiple simultaneous sessions.
- Chapter-aware navigation.
- Podcasts.
- Any client UI (that lives in the app repo).

Keep these out. Do not add speculative abstractions for them, but do not actively
prevent them either.

## 3. Architecture

Ratatoskr is the brain; clients are thin remotes. Audio never flows through Ratatoskr.

- Client -> Ratatoskr: control commands over the HTTP API in `contract/openapi.yaml`.
- Ratatoskr -> Audiobookshelf: REST calls to read the library and stored progress, and
  to write progress back.
- Ratatoskr -> Sonos speakers: Ratatoskr controls the speakers directly over UPnP/SOAP on
  the LAN (discovery, set the transport URI, play, pause, seek, and poll transport state)
  via the embedded node-sonos-ts library. There is no separate Sonos controller process.
- Audiobookshelf -> Sonos speaker: the speaker fetches the audio file directly over the
  LAN, using an ABS URL (with an access token as a query parameter) that Ratatoskr hands
  to it. That token belongs to a dedicated low-privilege streamer identity, never to the
  listening user (see section 14). Because access tokens are short-lived, Ratatoskr embeds
  a current token and re-sets the transport URI as needed, so long playback does not fail
  on expiry.

Audiobookshelf is the single source of truth for progress. Ratatoskr holds only the
current session, in memory. If Ratatoskr restarts, the session is lost but no progress
is lost, because it has been written to ABS.

## 4. The hard part: position mapping and seeking

This is where the real work is, and where bugs will concentrate. Isolate all of it in a
single, pure module with no I/O, and cover it with unit tests, so the sync loop stays
simple.

- An audiobook is often several audio files (tracks). ABS exposes progress as a single
  absolute offset in seconds across the whole book. Sonos plays a queue of tracks and
  reports the current track index plus elapsed time within that track.
- The position module must convert both ways: absolute seconds -> (trackIndex, offset),
  and (trackIndex, offset) -> absolute seconds, using the per-track durations from ABS.
- The position module treats the track durations as a validated precondition: it fails
  fast (throws) on a malformed list (empty, zero, non-finite), and only ever clamps
  position *values*. Because those durations originate from ABS metadata, not from a
  programmer, the `abs/` layer (library projection, section 13) is responsible for
  validating and normalizing them, and for surfacing a clear "cannot be played" error for
  a book with bad track metadata — so malformed data never reaches the position module or
  the sync loop.
- Seeking is finicky in practice. Expect to seek to the track first, then to the offset,
  and expect to need a small settle delay and a tolerance window before trusting the
  reported position. Make the delay, tolerance, and retry count configurable rather than
  hard-coded.
- Format: still detect the format from ABS metadata and surface a clear error if a book
  cannot be played rather than failing silently.

### Spike findings (2026-07-03, SYMFONISK, node-sonos-ts against real ABS files)

The manual risk spike from this section has been done. Results, which the implementation
must build on:

- **Direct playback works for MP3, FLAC, AAC (M4A) and M4B.** The historical `.m4b`
  concern did not materialise: ABS reports `.m4b` as mime type `audio/mp4`, and Sonos
  plays and seeks it like the others. No per-format fallback is needed.
- **Playback requires DIDL-Lite metadata, not a bare URL.** Setting a plain ABS file URL
  as the transport URI fails with UPnP error 714 ("Illegal MIME-Type") — the URL has no
  file extension for Sonos to sniff. The `sonos/` layer must send DIDL-Lite metadata whose
  `<res protocolInfo="http-get:*:<mime>:*">` carries the mime type from ABS. The mime is
  taken from the ABS audio-file metadata (`audio/mpeg`, `audio/flac`, `audio/mp4`).
- **The track URL is ABS's raw file endpoint** `GET {ABS_URL}/api/items/{itemId}/file/{ino}?token=…`.
  It serves the raw bytes with HTTP range support (so Sonos can seek within a track). The
  token is the streaming user's access token (see section 8).
- **Do not trust Sonos's reported track duration.** For these streamed files Sonos reports
  `TrackDuration = 0:00:00`. Absolute-position maths must use the per-track durations from
  ABS (exactly as the position module is specified above). The reported *elapsed* position
  within the track (`RelTime`) is reliable and is what the sync loop should read.
- **Seeking is accurate.** `Seek` with unit `REL_TIME` landed within ~0 s of the target,
  and the new position was reflected after roughly a 1 s settle. This gives the starting
  values for the tuning knobs in section 7: `SEEK_SETTLE_MS≈1000`, `SEEK_TOLERANCE_SECONDS≈3`,
  `SEEK_RETRIES≈2`.

## 5. The sync loop

- Poll the speaker every `POLL_INTERVAL_SECONDS` (default 15) and also react to
  pause/stop.
- Convert the reported position to absolute seconds via the position module.
- Only write to ABS when the position has moved by at least a threshold (default a few
  seconds) to avoid flooding ABS with updates.
- On stop, and when the app pauses, write the current position immediately.
- When the position reaches the end within a small tolerance, mark the item finished in ABS.
- On start, read stored progress from ABS and seek the speaker to it before entering the
  loop.

## 6. API and versioning

- `contract/openapi.yaml` is the single source of truth. Implement it exactly.
- Everything is mounted under `/v1`. Keep the version prefix in one place so a future
  `/v2` can be served alongside `/v1`.
- Backwards compatibility must hold in both directions: an older app must work against a
  newer server, and a newer app must degrade gracefully against an older server. In
  practice for the server: never remove or repurpose a field within `/v1`, only add
  optional ones; introduce breaking changes only under a new major version and path.
- A CI job runs oasdiff against the previous tagged contract and fails the build on an
  unflagged breaking change.

## 7. Configuration

All configuration is via environment variables, validated at startup with a clear error
if something required is missing:

- `ABS_URL` (required) — LAN URL of Audiobookshelf, reachable by both Ratatoskr and the
  speakers. Listening users authenticate per-user (see section 8); the only server-side
  ABS credential is the streamer identity below.
- `ABS_STREAMER_USER`, `ABS_STREAMER_PASSWORD` (required) — credentials of the dedicated
  low-privilege ABS account whose short-lived tokens are embedded in the media URLs handed
  to the speakers (see section 14). Ratatoskr logs this identity in at startup and
  refreshes it as needed.
- `TLS_CERT_PATH`, `TLS_KEY_PATH` (recommended) — serve the API over HTTPS (see
  section 14). If unset, the server refuses to start unless `ALLOW_PLAIN_HTTP=true` is
  set explicitly.
- Sonos speaker discovery is automatic over SSDP on the LAN — no URL to configure.
  `SONOS_SEED_HOST` (optional) — IP or hostname of one speaker, used as a discovery seed
  on networks where multicast/SSDP is unreliable.
- `PORT` (optional, default 8080).
- `POLL_INTERVAL_SECONDS` (optional, default 15).
- `SEEK_SETTLE_MS` (optional, default 1000), `SEEK_TOLERANCE_SECONDS` (optional, default 3),
  `SEEK_RETRIES` (optional, default 2) — tuning knobs for section 4; defaults come from the
  spike findings there.
- `PROGRESS_WRITE_THRESHOLD_SECONDS` (optional, default a few seconds).

## 8. Auth

Authentication is per-user and backed by Audiobookshelf, so that progress is attributed
to the person who is actually listening.

- A client authenticates by posting Audiobookshelf credentials to `POST /v1/auth/login`.
  Ratatoskr forwards them to Audiobookshelf and returns the access and refresh tokens plus
  the identified user. The client then sends the access token as a bearer token on every
  request, and Ratatoskr uses it for its upstream Audiobookshelf calls — so the library
  view and playback progress are scoped to that user.
- Access tokens are short-lived; clients exchange the refresh token for a new pair via
  `POST /v1/auth/refresh`. Both auth endpoints proxy to Audiobookshelf.
- All endpoints require a valid token except `/health`, `/auth/login`, and `/auth/refresh`.
  Validity is proven by the upstream Audiobookshelf call each endpoint makes with the token.
  `GET /speakers` is the one exception: Sonos discovery is local, so nothing is forwarded to
  ABS and the bearer token is checked for **presence only**. This is deliberate — a device on
  the same LAN can already enumerate the Sonos topology directly via SSDP/UPnP (section 14) — so
  it leaks nothing new; real per-request validation for it arrives with playback in phase 4.
- The listening user's token is used for Audiobookshelf **API** calls only. The media URLs
  handed to the speakers carry the dedicated streamer identity's token instead, because
  those URLs are readable by anyone on the LAN (section 14).

Ratatoskr keeps no user database. For the single active playback session it holds that
user's tokens in memory only, so the sync loop can renew the access token and keep writing
progress during long unattended playback; the tokens are discarded on stop and on restart.
There are no Ratatoskr-native accounts and no multi-tenant session store in v1 — one active
session at a time, owned by one authenticated user.

**Refresh-token rotation handover** (contract 1.1.0). Audiobookshelf rotates the refresh
token on every use, so when the sync loop renews the session user's tokens, the pair the
client stored at login is invalidated — without a hand-back channel the client's next
`/auth/refresh` would fail and force a re-login. The `Session` schema therefore carries an
optional `rotatedTokens` object (`accessToken` + `refreshToken`, both or neither).

This relies on two properties of Audiobookshelf's token model (verified against the
version this server targets; see the README's minimum-version requirement):

- Access tokens are **stateless** — validated by signature and expiry only, with no
  server-side session lookup — so a given access token stays valid until its own expiry
  even after the pair has been rotated. (Refresh tokens, by contrast, are stateful and the
  old one is invalidated the moment it is used.)
- Because Ratatoskr and the client hold the *same* access token during a session, the sync
  loop must **refresh proactively, before that token expires** — never only after a 401.
  This leaves a handover window in which the client's still-valid old access token can
  authenticate the very request that fetches the rotated pair. (Concrete lifetimes are an
  Audiobookshelf configuration detail — e.g. access tokens on the order of hours, refresh
  tokens on the order of weeks — so this spec states the ordering requirement, not a
  number.)

Server behavior:

- When the sync loop refreshes the session user's tokens, the server marks the new pair
  as pending delivery **to this client**.
- It includes `rotatedTokens` in every `Session` response until the client authenticates
  with the new access token — i.e. delivery is confirmed by **adoption, not by a single
  send**, so a dropped or half-read response cannot strand the client. Every playback
  operation returns a `Session`, so the pair reaches the client through the polling it
  already does for its now-playing view — no new endpoint. (v1 has exactly one session and
  one session user, so "this client" is simply the authenticated caller of a session
  endpoint.)
- `stopSession` discards the in-memory tokens, so a pair still pending at stop cannot be
  redelivered afterwards. To close that race, `stopSession` returns **200 with a final
  `Session`** carrying the pending `rotatedTokens` (instead of the usual 204) whenever a
  pair is outstanding.
- `rotatedTokens` appears in response bodies, so it falls under the log-redaction rule
  extended for it in section 14.

The client-side half of the protocol is specified in the app's SPEC, section 5: the client
never calls `/auth/refresh` while its session is active and adopts tokens only from
`Session` responses (including the 200 body from `stopSession`). On a 401 during an active
session it first re-fetches `getCurrentSession` — which succeeds because the old access
token is still valid until its expiry — to pick up a rotated pair, and only falls back to
`/auth/refresh` if none is offered. One irreducible residual remains: if the single
response that would carry the final pair at stop is lost in transit, the client re-logs in;
this is far narrower than the original send-once race and needs no persistence to recover
from. Implementation lands with the playback design (phase 4).

## 9. Testing

The full, authoritative test strategy for the server — the test levels (unit / component /
integration), the cross-cutting security and contract-conformance checks, the fakes
(including the repo-owned fake Sonos), and how CI runs them — lives in
[`docs/testing.md`](./testing.md). It is designed from this architecture and links back to
the central cross-component test concept. The mandatory cases below are the non-negotiable
minimum and are subsumed by that document; keep the two consistent.

- Unit tests for the position module are mandatory and should cover: single-file books,
  multi-file books, seeking across a track boundary, the start and the very end of a book,
  and rounding at track edges.
- Unit tests for the sync loop's write-back threshold and finished detection, with the
  ABS and Sonos clients mocked.
- Handlers can be covered with a light integration test using an in-memory server and
  mocked dependencies.

## 10. Definition of done for v1

- All endpoints in the contract are implemented and pass a contract-conformance check.
- A user can, from a client: list speakers, search the library, start a book on a speaker,
  hear it resume from the right spot, pause and resume, seek, and stop; and the reached
  position is visible in Audiobookshelf afterward.
- Progress survives a server restart (because it lives in ABS).
- README and this spec are accurate to what was built.

## 11. Coding constraints for the implementing agent

- Do not introduce a database or persistence layer; the only persistent state is in ABS.
- Do not add dependencies beyond what a small HTTP server, an HTTP client, and testing
  need, without a clear reason.
- Keep the position-mapping logic free of I/O; it is pure logic and must be unit-testable
  in isolation.
- Do not hand-edit generated client or type code.
- License headers, where used, are GPL-3.0-or-later.

## 12. Technology stack

Decided with the implementing agent. Rationale in brief, so it is not re-litigated.

- **Language / runtime:** TypeScript (strict mode) on Node.js (current LTS). Node is
  already in the critical path for Sonos control (see below), so consolidating the backend
  onto one runtime keeps the system to a single language, a single deploy artifact, and the
  maturest Sonos ecosystem.
- **Sonos control:** the node-sonos-ts library (`@svrooij/sonos`), embedded in-process. It
  is TypeScript-native and group-aware — its `SonosManager` handles SSDP discovery and
  zone-group topology — and exposes the AVTransport operations we need (set transport URI,
  play, pause, seek, poll state). There is no separate Sonos controller process (section 3).
- **HTTP server:** Fastify. Schema-first, with first-class JSON-schema request/response
  validation that pairs naturally with the OpenAPI contract.
- **HTTP client (Audiobookshelf):** the built-in `fetch` (undici). No extra HTTP dependency.
- **Contract to code:** a dedicated `@ratatoskr/contract` package generates, from
  `contract/openapi.yaml` in one build step, the request/response types
  (`openapi-typescript`), the runtime JSON schemas (with local `$ref`s rewritten for the
  validator), and the full OpenAPI document as a runtime object (`openapiDocument`). All are
  generated, never hand-edited (section 11), and shipped as a normal module — so nothing is
  parsed from the repo layout at runtime and the built package is self-contained for the
  container deployment.
- **Routing:** routes are driven from the contract by `fastify-openapi-glue`, not hand-wired.
  It registers every path, its request/response schemas, and its per-operation security
  straight from `openapiDocument`, and maps each `operationId` to a method on a single
  `ApiService` object (dependency injection via the constructor). This makes drift between the
  routes and the contract structurally impossible — a route's response codes and schemas *are*
  the contract's (an earlier hand-maintained response map had already drifted, missing a
  documented `400`). Handlers just return the payload or throw a domain error; auth and the
  domain-error→HTTP mapping are centralized (below).
- **Auth & errors (central):** a single `securityHandlers.bearerAuth` enforces the contract's
  bearer requirement as a preHandler (it stashes the token for the operations that forward it
  to ABS); operations declaring `security: []` are exempt. A single `mapError` turns every
  domain error and Fastify validation error into the contract's `{ code, message }` shape via
  the global error handler — no per-route error plumbing.
- **Contract conformance:** Fastify's route response schemas only *serialize* (via
  fast-json-stringify) — they guarantee required fields and strip unknown ones, but do
  not validate enum values or shape. Real conformance is asserted independently: the
  integration tests validate responses against the raw contract with Ajv, and response
  validation is additionally enabled in test builds (`@fastify/response-validation`).
  `oasdiff` runs in CI against the previous tagged contract for breaking-change detection,
  as section 6 requires.
- **Testing:** Vitest as the runner, Fastify's `inject` for handler-level integration
  tests, and lightweight fakes for the ABS and Sonos clients. The dependency set is kept
  deliberately small (section 11). The full strategy — test levels, the repo-owned fake
  Sonos (in-process here, published as a GHCR image the central E2E repo consumes), and the
  CI conformance gates — is documented in [`docs/testing.md`](./testing.md).
- **Deployment:** a single multi-stage Dockerfile, built for `amd64` and `arm64`
  (multi-arch), on a slim Node base image. One process, one container.
- **Container networking (Sonos):** Sonos discovery and UPnP eventing rely on UDP multicast
  and on the speakers being able to reach the server (event callbacks). Docker's default
  bridge network NATs the container onto its own subnet, which blocks both: SSDP discovery
  finds nothing and the speaker→server event path is severed. Run the container with **host
  networking** (`network_mode: host`, Linux) so it shares the host's LAN stack — the robust
  default for a LAN appliance. Where that is not possible, set `SONOS_SEED_HOST` (section 7):
  the client then loads the zone topology by a direct unicast call to that speaker instead of
  multicast, and `/speakers` re-reads the topology live per request, so it stays correct even
  without event callbacks. (Outbound control — set transport URI, play/pause/seek, poll — and
  the speaker fetching audio from ABS both work under bridge networking regardless.)

Note on the F-Droid build: `openapi-generator` still produces the Kotlin *client* used by
the Android app in its own hermetic F-Droid build. That is driven entirely by
`contract/openapi.yaml` and is unaffected by the server's implementation language.

## 13. Module structure

The one hard constraint on structure (sections 4 and 11) is that the position-mapping
logic must be pure and I/O-free. This is enforced architecturally, not by convention: the
position logic lives in its own workspace package with zero runtime dependencies, so I/O
cannot leak into it.

The repository is an npm/pnpm workspace with three packages:

```
ratatoskr-server/
├── packages/
│   ├── position/             # @ratatoskr/position — pure TypeScript, ZERO runtime deps
│   │   ├── positionMapper.ts  #   absolute seconds <-> (trackIndex, in-track offset)
│   │   ├── playbackPlan.ts     #   which track URLs to play; direct vs. per-track fallback,
│   │   │                       #   derived from ABS metadata (the .m4b / format decision)
│   │   └── seekPlan.ts         #   "seek to track, then to offset" as a plain data structure;
│   │                           #   settle delay, tolerance and retries are PARAMETERS, not env
│   │
│   ├── contract/             # @ratatoskr/contract — generated from contract/openapi.yaml
│   │   └── src/generated/     #   request/response types + runtime JSON schemas ($ref-rewritten),
│   │                          #   emitted by the generate step; never hand-edited (section 11)
│   │
│   └── app/                   # @ratatoskr/app — the service (all I/O); depends on the other two
│       ├── config/             #   load and validate environment variables at startup
│       ├── abs/                #   Audiobookshelf client: library projection, progress read/write
│       ├── sonos/              #   node-sonos-ts wrapper: discovery, transport URI, play/pause/seek, poll
│       ├── playback/           #   session manager (the single in-memory session) + the sync loop
│       ├── api/                #   Fastify routes, auth hook, error mapping, the /v1 mount,
│       │                       #   and mapping between the domain and the contract types
│       └── main.ts             #   startup wiring
```

The purity of `@ratatoskr/position` is enforced by it having no runtime dependencies at
all; a scoped ESLint import-boundary rule additionally forbids its `src/` from importing
Node built-ins or other workspace packages.

Keeping the generated contract artifacts in their own `@ratatoskr/contract` package (rather
than inside `app`) means the app imports them as an ordinary module and never reads the
contract file or walks the repo layout at runtime — so the built container image, which
ships neither the workspace files nor the contract source, boots correctly.

Design principle for the fragile part: **`position` decides *what* should happen** (track
and offset, the list of track URLs, the ordered seek steps) as pure data; **the `sonos`
wrapper carries it out** and owns the settle delay, tolerance window and retries (the
tuning knobs from section 7). All of the finicky logic is therefore unit-testable without
hardware. The sync loop in `playback/` stays thin: poll, convert to absolute seconds via
`position`, apply the write-back threshold, and write to ABS when warranted.

The single API version prefix (`/v1`) is defined in one place in `api/`, so a future
`/v2` can be mounted alongside it (section 6).

## 14. Security

Threat model: the home LAN is not fully trusted — assume guest devices and compromised
IoT hardware on the same network. Sonos UPnP control is unauthenticated by nature: any
LAN device can control any speaker **and read the current transport URI back** via
`GetMediaInfo`. The audio path (ABS -> speaker) is always cleartext HTTP, because Sonos
speakers do not trust custom certificate authorities. Ratatoskr does not attempt to gate
speaker control (pointless), but it must not leak anything through these channels that is
worth more than the audio itself.

Decisions (binding for the implementation):

- **Media URLs never carry a listening user's token.** Since the transport URI (including
  its `?token=` query parameter) is readable by anyone on the LAN, the URLs handed to the
  speakers use the short-lived access token of a dedicated ABS account
  (`ABS_STREAMER_USER`) that has read/stream access to the library and nothing else. A
  leaked media URL is then worth at most read access to the library for about an hour —
  not the listener's account. The listening user's tokens exist only inside Ratatoskr
  (and on the user's own client). Setup cost: the admin creates this account in ABS once.
- **TLS between clients and Ratatoskr.** Login credentials and the 30-day refresh token
  must not cross the network in cleartext. Ratatoskr serves HTTPS using a self-signed
  certificate or a local CA (`TLS_CERT_PATH` / `TLS_KEY_PATH`); the Android app pins that
  certificate via its network security configuration (works with the hermetic F-Droid
  build; no public CA involved). Plain HTTP requires the explicit opt-out
  `ALLOW_PLAIN_HTTP=true` — for setups that terminate TLS in a reverse proxy or accept
  the risk knowingly.
- **Log redaction is normative.** Never log `Authorization` headers, query strings
  containing `token`, the request bodies of the `/auth/*` endpoints, or response bodies
  that carry tokens — specifically the `AuthTokens` returned by `/auth/*` and the
  `rotatedTokens` object on a `Session` (section 8). The error mapper strips URLs from
  upstream errors before they reach responses or logs. (Also note: ABS and any proxy in
  between will log media-URL query strings — one more reason those URLs carry only the
  streamer token.)
- **Rate-limit the unauthenticated endpoints.** `/auth/login` and `/auth/refresh` get a
  conservative per-IP rate limit so Ratatoskr is not a free brute-force funnel in front
  of ABS.

Hardening checklist (small items, still binding):

- Validate and URL-encode client-supplied path parameters (`itemId`) before they enter
  upstream URLs.
- `/health` stays unauthenticated but reports only coarse reachability — no versions,
  no URLs.
- No CORS headers (the API is not for browsers); bearer-token auth means no cookie-based
  CSRF surface.
- Commit the lockfile; run `npm audit` in CI.
- The container runs as a non-root user.

Known accepted risks / open points:

- The streamer token in the media URL remains readable on the LAN (UPnP, HTTP sniffing,
  ABS access logs). Accepted: it is short-lived and minimally privileged.
- ABS itself is typically served over plain HTTP on the LAN; securing it is outside this
  project's scope, but a reverse proxy with TLS in front of both services is a sensible
  deployment.
- Refresh-token rotation: ABS rotates refresh tokens on every use, so the app and the
  server must not both consume the same refresh token independently. Addressed at the
  contract level (1.1.0): the client hands its refresh token over in `startSession`, the
  server hands rotated pairs back through the optional `Session.rotatedTokens` object and
  the 200 `stopSession` body (see section 8). The operational risk remains open until the
  phase-4 server implementation lands.
- `/health` is unauthenticated and currently triggers one upstream Audiobookshelf request
  per call, so a poller (or a hostile LAN device) amplifies 1:1 into ABS load. Deferred:
  cache the dependency status for a short TTL once the polling/reachability patterns exist
  in phase 4/5, rather than building caching infrastructure without that context.

## 15. Next steps

Planned work, not yet built. Captured here so the intent is not lost; each lands in its
own change with its own tests.

- **Integration test against a real Audiobookshelf.** The `abs/` client is currently
  covered only against `fetch` stubs, so it verifies our own parsing but not that the
  request shapes and response shapes match a live ABS. Add an integration test that runs
  the client (login/refresh and the library projection) against a real or containerized
  Audiobookshelf, gated so it does not run in the normal unit-test pass (it needs a
  reachable ABS). This closes the open item from the phase-3a review — a smoke test against
  a live ABS before phase 4 builds playback on top of the projection.
- **Bundle the server for a smaller deploy artifact.** The build is currently `tsc`-only:
  it emits per-file JavaScript and ships `node_modules` into the container. Introduce a
  bundling step (e.g. esbuild or rollup) that tree-shakes the server (`packages/app`) into
  a single artifact with dead code eliminated, to shrink the container image and speed
  startup. Must stay compatible with the single multi-stage, multi-arch Dockerfile
  (section 12) and must not pull generated contract types/schemas out of their normal
  module boundary (section 11).