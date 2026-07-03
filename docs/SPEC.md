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
  LAN, using an ABS URL (with the streaming user's access token as a query parameter) that
  Ratatoskr hands to it. Because access tokens are short-lived, Ratatoskr embeds a current
  token and re-sets the transport URI as needed, so long playback does not fail on expiry.

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
  speakers. Ratatoskr holds no Audiobookshelf token of its own; it authenticates per-user
  (see section 8).
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

Ratatoskr keeps no user database. For the single active playback session it holds that
user's tokens in memory only, so the sync loop can renew the access token and keep writing
progress during long unattended playback; the tokens are discarded on stop and on restart.
There are no Ratatoskr-native accounts and no multi-tenant session store in v1 — one active
session at a time, owned by one authenticated user.

## 9. Testing

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
- **Contract to code:** `openapi-typescript` generates the request/response types from
  `contract/openapi.yaml` into a source that is never hand-edited. The Fastify routes are
  written by hand against those types. This satisfies the "do not hand-edit generated type
  code" constraint (section 11).
- **Contract conformance:** the OpenAPI schema is enforced at the edge (Fastify schema
  validation) and exercised in the integration tests, so responses cannot silently drift
  from the contract. `oasdiff` runs in CI against the previous tagged contract for
  breaking-change detection, as section 6 requires.
- **Testing:** Vitest as the runner, Fastify's `inject` for handler-level integration
  tests, and lightweight fakes for the ABS and Sonos clients. The dependency set is kept
  deliberately small (section 11).
- **Deployment:** a single multi-stage Dockerfile, built for `amd64` and `arm64`
  (multi-arch), on a slim Node base image. One process, one container.

Note on the F-Droid build: `openapi-generator` still produces the Kotlin *client* used by
the Android app in its own hermetic F-Droid build. That is driven entirely by
`contract/openapi.yaml` and is unaffected by the server's implementation language.

## 13. Module structure

The one hard constraint on structure (sections 4 and 11) is that the position-mapping
logic must be pure and I/O-free. This is enforced architecturally, not by convention: the
position logic lives in its own workspace package with zero runtime dependencies, so I/O
cannot leak into it.

The repository is an npm/pnpm workspace with two packages:

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
│   └── app/                   # @ratatoskr/app — the service (all I/O); depends on position
│       ├── config/             #   load and validate environment variables at startup
│       ├── abs/                #   Audiobookshelf client: library projection, progress read/write
│       ├── sonos/              #   node-sonos-ts wrapper: discovery, transport URI, play/pause/seek, poll
│       ├── playback/           #   session manager (the single in-memory session) + the sync loop
│       ├── api/                #   Fastify routes, auth hook, error mapping, the /v1 mount,
│       │                       #   and mapping between the domain and the generated contract types
│       └── main.ts             #   startup wiring
│
└── (generated contract types in their own never-hand-edited source)
```

The purity of `@ratatoskr/position` is enforced by it having no runtime dependencies at
all; an ESLint import-boundary rule additionally forbids importing Node built-ins or the
app package from it.

Design principle for the fragile part: **`position` decides *what* should happen** (track
and offset, the list of track URLs, the ordered seek steps) as pure data; **the `sonos`
wrapper carries it out** and owns the settle delay, tolerance window and retries (the
tuning knobs from section 7). All of the finicky logic is therefore unit-testable without
hardware. The sync loop in `playback/` stays thin: poll, convert to absolute seconds via
`position`, apply the write-back threshold, and write to ABS when warranted.

The single API version prefix (`/v1`) is defined in one place in `api/`, so a future
`/v2` can be mounted alongside it (section 6).