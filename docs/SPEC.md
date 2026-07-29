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
  Every list response (browse, search, and the in-progress shelf) carries the user's
  stored progress on each item: the server fetches the user's `mediaProgress` map from
  ABS once per list request (`GET /api/me`) and joins it into the summaries — one
  upstream call per list, never one per item. A book with no listening history carries
  no `progress` field. Progress is auxiliary to a list: if the lookup fails, the list is
  still served without `progress` and a warning is logged, never a failed request.
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
  LAN, using an ABS URL (with a token as a query parameter) that Ratatoskr hands to it.
  That token is an ABS **API key** for a dedicated, stream-only streamer identity, never
  the listening user (see section 14). The key is long-lived, so there is no expiry to
  manage during playback — nothing to re-set on the transport URI.

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
- The position written to ABS is stepped back by `WRITE_POSITION_BACKOFF_SECONDS` (default 2),
  because Sonos's reported `RelTime` runs slightly ahead of the audible output (buffering), so
  writing it verbatim leaves ABS a touch ahead of what was actually heard. A *finished* write
  stores the exact end, not a backed-off value.
- When the position reaches the end within a small tolerance, mark the item finished in ABS.
- On start, read stored progress from ABS and seek the speaker to `RESUME_REWIND_SECONDS`
  (default 10) *before* the stored position — the podcast/audiobook convention of stepping back a
  little so the listener re-orients — clamped at 0, before entering the loop. A finished book still
  restarts from the beginning. Set either knob to 0 to disable it.
- On a termination signal (SIGTERM/SIGINT), stop the active session — writing the reached
  position back to ABS — before exiting, bounded by `SHUTDOWN_TIMEOUT_MS` so a hung write cannot
  wedge the process. (Progress still survives an ungraceful kill, since it is written periodically
  during playback; this just captures the last few seconds on a clean `docker stop`.)

## 6. API and versioning

- `contract/openapi.yaml` is the single source of truth. Implement it exactly.
- Everything is mounted under a version prefix, and that prefix lives in one place **per major**:
  each mount derives it from the `servers.url` of the very document it registers. A major's routes
  and the URLs its responses hand out therefore cannot drift apart, and no build-wide prefix can
  give one major's answer to both.
- Two majors are served side by side, from one process, each from its own document:
  **2.0.0 under `/v2`** — the auth surface of
  [ADR-0001](./adr/0001-client-auth-ratatoskr-native-sessions.md), cut in one breaking step with no
  deprecation markers, since `/v1` clients read the frozen 1.4.0 tag — and **1.4.0 under `/v1`**,
  frozen, until its sunset (then an unauthenticated 410 `UPGRADE_REQUIRED` stub). One
  `fastify-openapi-glue` registration per major, each with its own service, security handlers and
  contract-derived token guard; assembling that list is the only place that knows there is more than
  one, so sunsetting `/v1` is removing an entry. The `/v2` auth operations that need the session
  store still answer 404 until their own issue lands — deliberately, rather than answering with an
  Audiobookshelf credential under a name that promises a Ratatoskr one — so for that window `/v2`
  lags this document.
- `/v1` is frozen at the **`contract-1.4.0`** tag, and what it mounts is a tracked copy of that
  document at `contract/v1/openapi.yaml`. The `contract-freeze` CI job is what makes that a freeze
  rather than a duplicate: it holds the copy byte-identical to the tag. The accident it exists for is
  not a deliberate edit but a sweep — a reformat, a lint rule, a search-and-replace across
  `contract/**` — silently reshaping the surface installed app versions talk to. The copy exists at
  all because generating the served artifacts must need no git history: `.git` is deliberately
  outside the image build context, and keeping that hermetic is worth more than avoiding a copy.
- Backwards compatibility must hold in both directions: an older app must work against a
  newer server, and a newer app must degrade gracefully against an older server. In
  practice for the server: never remove or repurpose a field within a served major, only
  add optional ones; introduce breaking changes only under a new major version and path.
- A CI job runs oasdiff between the PR's base and head and fails the build on a breaking
  change. It reads `info.version` on both sides and skips itself when the major differs,
  which is exactly the case this rule allows — so a major cut needs no manual flag, and
  everything else stays gated. It grades the contract under development only: the other served
  major is frozen rather than versioned, and `contract-freeze` gates that one more strictly than any
  breaking-change check could.
- Any operation whose request is validated — a bounded or typed query param, a required body, a
  path param — must declare `400: BadRequest` in the contract. Fastify rejects an invalid request
  with a 400 before the handler runs (mapped to the contract's error shape, section 12), so an
  endpoint that omits it documents a response it does not actually have. This has been a recurring
  omission on new endpoints: whenever a parameter carries constraints, add the `400`.

## 7. Configuration

All configuration is via environment variables, validated at startup with a clear error
if something required is missing:

- `ABS_URL` (required) — LAN URL of Audiobookshelf, reachable by both Ratatoskr and the
  speakers. Should be `https://` so per-user credentials and tokens do not cross the network
  in cleartext (see section 14). A plain-HTTP URL requires the explicit opt-out
  `ABS_ALLOW_PLAIN_HTTP=true`. Listening users authenticate per-user (see section 8); the only
  server-side ABS credential is the streamer identity below. At startup Ratatoskr probes
  `ABS_URL` and refuses to start if the host responds but is not Audiobookshelf (a network
  error is tolerated — the server starts and reports it via `/health`).
- `ABS_ALLOW_PLAIN_HTTP` (optional) — accept a plain-HTTP `ABS_URL`. Only for a trusted LAN or
  when TLS is terminated by a reverse proxy.
- `ABS_CA_CERT_PATH` / `ABS_CA_CERT` (optional, mutually exclusive) — trust a self-signed or
  private-CA Audiobookshelf certificate, as a PEM file path or inline PEM. Verification stays on.
- `ABS_TLS_INSECURE` (optional) — last resort: disable ABS certificate verification entirely
  (vulnerable to MITM). Mutually exclusive with the `ABS_CA_CERT*` options.
- `ABS_STREAMER_API_KEY` (required) — an ABS API key for a dedicated, stream-only account,
  embedded in the media URLs handed to the speakers (see section 14). The operator creates the
  key in ABS (Settings → Users → API Keys) for a low-privilege account; Ratatoskr just embeds it,
  with no login or token refresh to do.
- `ABS_REQUEST_TIMEOUT_MS` (optional, default 10000) — per-request cap on Audiobookshelf HTTP
  calls, so a hung ABS (down / slow / packet-dropping) surfaces as a prompt 502 upstream error
  rather than a stalled request. Set it below a client's own read timeout so the client sees the
  server's mapped error, not its own timeout. (The startup `GET /ping` probe has its own short,
  fixed timeout and is unaffected.)
- `TLS_CERT_PATH`, `TLS_KEY_PATH` (recommended) — serve the API over HTTPS (see
  section 14). If unset, the server refuses to start unless `ALLOW_PLAIN_HTTP=true` is
  set explicitly.
- Sonos speaker discovery is automatic over SSDP on the LAN — no URL to configure.
  `SONOS_SEED_HOST` (optional) — IP or hostname of one speaker, used as a discovery seed
  on networks where multicast/SSDP is unreliable.
- `SONOS_REQUEST_TIMEOUT_MS` (optional, default 4000) — per-request cap on Sonos SOAP/discovery
  I/O. A speaker that vanishes mid-session (powered off / off the network) drops packets rather
  than refusing the connection, so an unbounded read would hang the live topology/transport reads
  — and with them `GET /v2/sessions/current` — indefinitely. This bounds each call so a dead
  speaker surfaces promptly as a 502 (section 4) instead of a hung request.
- `SONOS_LISTENER_HOST`, `SONOS_LISTENER_INTERFACE`, `SONOS_LISTENER_PORT` (optional,
  pass-through) — read directly by the embedded Sonos library, not validated by Ratatoskr's
  startup config. They pin the UPnP event-callback listener the speakers call back to: by
  default the library binds port 6329 and advertises the first non-internal IPv4 found across
  all interfaces, which on a multi-homed host (VPNs, virtualization bridges, a NAS with one
  Docker bridge per app) can be an address the speakers cannot reach — eventing then breaks
  silently while discovery and control still work. Set `SONOS_LISTENER_HOST` to the host's LAN
  IP on such machines (or pin the interface by name with `SONOS_LISTENER_INTERFACE`).
- `PORT` (optional, default 8080).
- `POLL_INTERVAL_SECONDS` (optional, default 15).
- `SEEK_SETTLE_MS` (optional, default 1000), `SEEK_TOLERANCE_SECONDS` (optional, default 3),
  `SEEK_RETRIES` (optional, default 2) — tuning knobs for section 4; defaults come from the
  spike findings there.
- `PROGRESS_WRITE_THRESHOLD_SECONDS` (optional, default 5).
- `SESSION_STORE_KEY` / `SESSION_STORE_KEY_FILE` (required once the `/v2` auth model lands,
  mutually exclusive) — key for the encrypted session store (section 8), as a value or a
  Docker-secret-compatible file path. A 256-bit key, base64- or hex-encoded (`openssl rand
  -base64 32`); a trailing newline in the file variant is tolerated. Missing key → the server
  refuses to boot; wrong key → a clear error, never silent data loss.
- `SESSION_STORE_PATH` — where that store file lives (section 8). Deliberately without a default,
  like `TLS_CERT_PATH`/`TLS_KEY_PATH`: which directory outlives a container recreation is a
  property of the deployment, and a wrong guess would silently sign every device out on the next
  restart. The container entrypoint supplies it the same way it supplies the certificate paths,
  pointing into the image's own `/data` volume (the server's own persistent state, so future
  additions have somewhere to go without another rename) — separate from the certificate's
  `/tls`, since the certificate is regenerable and the store is not (see section 8).
- `LISTENING_TOKEN_REFRESH_MARGIN_SECONDS` (optional, default 300) — how far before the listening
  user's access token expires the sync loop renews it, so the rotated pair reaches the client while
  its old access token is still valid. Serves the `/v1` rotation-handover protocol only (frozen
  1.4.0 contract, see section 8) and is removed together with `/v1`.
- `SHUTDOWN_TIMEOUT_MS` (optional, default 5000) — upper bound on the graceful-shutdown drain
  (section 5); the process exits after this even if the final write is still hung.
- `RESUME_REWIND_SECONDS` (optional, default 10) — resume this many seconds before the stored
  position on start (section 5). 0 disables it.
- `WRITE_POSITION_BACKOFF_SECONDS` (optional, default 2) — step the position written to ABS back
  by this much, since Sonos's `RelTime` leads the audible output (section 5). 0 disables it.

## 8. Auth

Authentication is per-user and backed by Audiobookshelf, so that progress is attributed
to the person who is actually listening. The client credential, however, is
**Ratatoskr-issued**: the server is the sole holder of ABS token pairs
([ADR-0001](./adr/0001-client-auth-ratatoskr-native-sessions.md), decided in
[#125](https://github.com/Xexanos/ratatoskr-server/issues/125)). This section describes the
model of contract 2.0.0 under `/v2` — cut in the contract, with the server-side pieces
landing in follow-up issues (section 6). The previous shared-token model and its
rotation-handover protocol stay served under `/v1`, frozen at the 1.4.0 contract tag,
until the sunset described in the ADR — the old protocol's specification lives in that
tag, not here.

The hard requirement this model exists to meet: **the user stays signed in until an
explicit sign-out.** Server restarts and arbitrarily long usage pauses must never force a
re-login.

- **Sign-in**: the client posts Audiobookshelf credentials to `POST /v2/auth/login`.
  Ratatoskr validates them against ABS — creating its own, private ABS session chain for
  this device login — and returns an opaque Ratatoskr token plus the identified user. The
  password is never stored, on either side; the client never sees ABS tokens.
- **The Ratatoskr token** is an opaque 256-bit random value, sent as a bearer token on
  every request. It does not expire and is never rotated — it is valid until explicit
  sign-out, and revocable at any moment by deleting its session entry. The server stores
  only its **hash**; validation is an in-process lookup. (Rationale and the security
  comparison against expiring/rotating alternatives: ADR-0001.)
- **Session store**: one entry per device login — the token hash, that device's own ABS
  chain, and metadata. **One ABS chain per device, never shared**; no two consumers of a
  rotating chain ever exist again. The store is a single AES-256-GCM-encrypted file on its
  own mounted volume (`/data` in the container), file mode 0600, non-root — deliberately not
  the certificate's volume, revising ADR-0001's "existing mounted volume": the two share no
  lifecycle, since a certificate can be regenerated at the price of re-confirming its
  fingerprint, while this file is irreplaceable and losing it signs every device out. That
  also makes the backup rule one sentence: back up `/data`, not the cert. The key is
  operator-supplied and mandatory (`SESSION_STORE_KEY`, section 7); without it the server
  refuses to boot, same fail-loud pattern as the ABS-URL probe (section 14).
- **Keep-alive**: the server refreshes every stored ABS chain daily (jittered), refreshes
  stale chains on boot, and refreshes on demand when an access token expires mid-use. A
  chain now dies only if server↔ABS contact is lost for the entire ABS refresh window
  (≥ 7 days by default) or on an ABS username change. Operator guidance: raise ABS's
  `REFRESH_TOKEN_EXPIRY` (e.g. to 90 days) if longer outages are expected.
- **Dead chain, valid token**: the keep-alive loop marks a dead chain but keeps the entry,
  so the user's next request answers **401 with the machine-readable
  `code: "UPSTREAM_SESSION_LOST"`** in the error body instead of a generic "unknown
  token". The app reacts with a targeted password prompt; re-login creates a fresh chain
  and a **new** token and deletes the old entry (no in-place repair). This failure is rare
  and loud — the inverse of the old model's frequent silent re-logins.
- **Sign-out** (`POST /v2/auth/logout`): delete the session entry — the token is dead
  immediately — and fire a best-effort ABS `POST /logout` with the held refresh token,
  killing exactly this device's ABS session; other devices and other ABS clients are
  untouched. Idempotent and best-effort: unknown token or unreachable ABS still answers
  204 (an orphaned ABS session expires on its own, since nobody refreshes it).
- All endpoints require a valid Ratatoskr token except `/health`, `/auth/login`, and
  `GET /speakers`. The **token guard** is now an in-process hash lookup — no per-request
  ABS roundtrip — but keeps deriving the protected set from the contract, so a new
  operation is guarded by default and cannot silently skip validation.
  `GET /speakers` stays deliberately unauthenticated (decided in contract 1.4.0): Sonos
  discovery is local, nothing is forwarded to ABS, and a device on the same LAN can
  already enumerate the Sonos topology directly via SSDP/UPnP (section 14) — a token
  requirement would gate nothing. The speaker list carries only ids, names, and group
  membership; the id is only usable through the authenticated playback endpoints.
- **Upstream calls** use the session entry's ABS chain — so the library view and playback
  progress remain scoped to the ABS user who signed in, and the sync loop keeps writing
  progress during long unattended playback without any client involvement. The media URLs
  handed to the speakers carry the dedicated streamer identity's API key instead, because
  those URLs are readable by anyone on the LAN (section 14).

**What `/v1` still runs.** The frozen major keeps every part of the old model, unchanged, in
a service of its own: the `POST /v1/auth/login` and `POST /v1/auth/refresh` proxies that hand
ABS token pairs to the device, the optional `refreshToken` on `PUT /v1/sessions/current` that
arms the sync loop's renewal (`LISTENING_TOKEN_REFRESH_MARGIN_SECONDS`, section 7 — that knob
serves this route alone), and the rotation handover, including the
`DELETE /v1/sessions/current` that answers 200 with a final `Session` when a rotated pair was
still owed. Everything else is implemented once and inherited by both majors, so the shared
operations cannot drift apart by accident — with the consequence that **a change to a shared
method changes `/v1` too**. `/v2`'s move from the caller's bearer to a session-resolved
upstream token is exactly such a change, and belongs in an override on the `/v2` side rather
than in the shared body. Until it lands, `/v2` still validates the bearer against ABS per
request; what exists today is the seam that lets one major's auth model be replaced without
touching the other's.

**The one thing the two majors share.** Not the handover — it cannot be armed or delivered
under `/v2`, which has no field for it — but the single active playback session, of which there
is still exactly one. A `/v2` caller presenting the same Audiobookshelf access token a `/v1`
client is listening with can stop that session, and a rotated pair the `/v1` client had not yet
collected is discarded with it, because `/v2`'s stop hands nothing back. The `/v1` client then
re-authenticates. This needs one device speaking both majors with the same upstream token, and
it stops being expressible once `/v2` bearers are Ratatoskr tokens. It is recorded here, and at
the `/v2` stop itself, rather than papered over: the alternative would be a `/v2` response
carrying an upstream credential under a field its own contract does not declare.

The client-side half is specified in the app's SPEC, section 5, and degenerates to:
attach the token; on 401 + `UPSTREAM_SESSION_LOST` show a targeted re-login prompt; on any
other 401 treat the device as signed out. The entire rotation-adoption protocol on the app
side drops with `/v1`.

Progress and user data still live in ABS only (section 11); the session store persists
**credentials**, not domain state. There are no Ratatoskr-native accounts — identity is
ABS identity — and still exactly one active playback session at a time, owned by one
authenticated user. A later operator view over the store (list sessions, sign out a
device) is a planned feature on top of this model, tracked in the issue tracker
(section 16).

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

- Do not introduce a database or persistence layer for **domain state** — progress and user
  data live in ABS only. The single deliberate exception is the encrypted session store of
  section 8 (credentials, not domain state), decided in
  [ADR-0001](./adr/0001-client-auth-ratatoskr-native-sessions.md); do not extend it beyond
  that purpose.
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
  (multi-arch), on a slim Node base image. One process, one container. The container entrypoint
  provides a zero-config transport default: when neither TLS (`TLS_CERT_PATH`/`TLS_KEY_PATH`) nor
  `ALLOW_PLAIN_HTTP=true` is set, it generates a persistent self-signed certificate (stored on a
  volume, reused across restarts) and serves HTTPS, logging its SHA-256 fingerprint — see the TLS
  decision in section 14. The application itself remains strict (it refuses to start without a
  transport decision); the convenience lives only in the container.
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

The repository is an npm/pnpm workspace with five packages:

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
│   ├── app/                   # @ratatoskr/app — the service (all I/O); depends on the two above
│   │   ├── config/             #   load and validate environment variables at startup
│   │   ├── auth/               #   the encrypted session store: one entry per device login
│   │   │                       #   (token hash + that device's ABS chain), AES-256-GCM on the volume
│   │   ├── abs/                #   Audiobookshelf client: library projection, progress read/write
│   │   ├── sonos/              #   node-sonos-ts wrapper: discovery, transport URI, play/pause/seek, poll
│   │   ├── playback/           #   session manager (the single in-memory session) + the sync loop
│   │   ├── api/                #   Fastify routes, auth hook, error mapping, the per-major version
│   │   │                       #   mount (apiPrefix.ts), and mapping between the domain and the
│   │   │                       #   contract types: contractMapping.ts is the one place
│   │   │                       #   contract-shaped library and session values are built, and
│   │   │                       #   the only place a cover URL is minted; domainShapeAssertion.ts
│   │   │                       #   makes skipping that step a build error rather than a wrong URL
│   │   │   └── v1/             #   what contract 2.0.0 dropped, served frozen under /v1 until its
│   │   │                       #   sunset: the credential proxies and the rotation handover. Extends
│   │   │                       #   the shared service; deleted whole when /v1 goes (section 8)
│   │   └── main.ts             #   startup wiring
│   │
│   ├── fake-sonos/           # @ratatoskr/fake-sonos — the UPnP/SOAP speaker double (test-only):
│   │                          #   imported in-process by tests, and built into the container
│   │                          #   image the central E2E repo consumes (docs/testing.md)
│   │
│   └── integration-tests/    # @ratatoskr/integration-tests — process-level tests that spawn
│                              #   the compiled app and drive it over real HTTP (docs/testing.md)
```

The purity of `@ratatoskr/position` is enforced by it having no runtime dependencies at
all; a scoped ESLint import-boundary rule additionally forbids its `src/` from importing
Node built-ins or other workspace packages.

The contract types stay inside `api/`, enforced the same way: a second import-boundary rule
forbids `@ratatoskr/contract` everywhere in `app/src` except `api/` itself and
`contractTypeAssertion.ts` (whose own header explains why it has to sit outside `api/`). The
same rule forbids the core from importing `api/` at all — the dependency runs one way, and
that also stops the first half being sidestepped by re-exporting the contract types from
somewhere in `api/`. So the core speaks domain types and `api/contractMapping.ts` is the
only place they become contract-shaped.

The point is not tidiness: a value shaped for one API major must not escape a module that
cannot know which major is being served — that is what made the cover URL, minted deep in
the ABS projection, the wrong thing in the wrong place. Both halves are default-deny, so a
new core module is covered the moment it lands.

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

The API version prefix is not written down in the server at all: `apiPrefix.ts` derives it from
the contract's `servers.url`, the one place section 6 puts it, so the mounted routes and the URLs
the API hands out cannot drift from the contract that documents them. A second major is mounted by
serving a second document, not by adding a second constant.

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
  speakers use an ABS **API key** (`ABS_STREAMER_API_KEY`) for a dedicated account that has
  read/stream access to the library and nothing else. A leaked media URL is then worth at
  most read/stream of the library — never the listener's account, and never a write. The key
  is long-lived (an ABS API key cannot be exchanged for a short-lived token, and the URL must
  keep working across a multi-hour book without a mid-track re-fetch failing), so the tradeoff
  is deliberate: the leak window is not time-bounded, but it is tightly *scope*-bounded to a
  low-privilege, read-only account. The listening user's tokens exist only inside Ratatoskr
  (and on the user's own client). Setup cost: the admin creates the stream-only account once
  and generates one API key for it (Settings → Users → API Keys), then locks the account down
  (no download/upload/delete, minimal library access).
- **TLS between clients and Ratatoskr.** Login credentials and the bearer credential (the
  non-expiring Ratatoskr token, section 8) must not cross the network in cleartext. Ratatoskr serves HTTPS using a self-signed
  certificate or a local CA (`TLS_CERT_PATH` / `TLS_KEY_PATH`); the Android app trusts it on
  first connect by its SHA-256 certificate fingerprint (trust-on-first-use — the fingerprint is
  shown on the connect screen), so hostname/CA validation is not required and no public CA is
  involved. Because trust is pinned to the exact certificate, that certificate must be stable
  across restarts. The container image leans on this: with no TLS configured and no plain-HTTP
  opt-out, its entrypoint generates a **persistent** self-signed certificate (on a mounted volume)
  and logs the fingerprint to verify against the app — a secure zero-config default that is
  strictly better than cleartext. Plain HTTP requires the explicit opt-out `ALLOW_PLAIN_HTTP=true`
  — for setups that terminate TLS in a reverse proxy or accept the risk knowingly.
- **Log redaction is normative.** Never log `Authorization` headers, query strings
  containing `token`, the request bodies of the `/auth/*` endpoints, or response bodies
  that carry credentials — the Ratatoskr token returned by `/v2/auth/login`, and on the
  frozen `/v1` surface the `AuthTokens` from `/auth/*` and the `rotatedTokens` object on a
  `Session`, until `/v1` sunsets. The error mapper strips URLs from upstream errors before
  they reach responses or logs. (Also note: ABS and any proxy in between will log
  media-URL query strings — one more reason those URLs carry only the streamer API key.)
- **Rate-limit the credential endpoints.** `/auth/login` (and `/v1`'s `/auth/refresh`
  while it is still served) get a conservative per-IP rate limit so Ratatoskr is not a
  free brute-force funnel in front of ABS. The other unauthenticated endpoints (`/health`,
  `GET /speakers`) take no credentials and stay unlimited — they serve cached local state
  and are polled legitimately.
- **The session store is encrypted, keyed by the operator.** The per-device ABS chains and
  Ratatoskr token hashes (section 8) persist as a single AES-256-GCM file on the mounted
  volume, key from `SESSION_STORE_KEY` (mandatory — no key, no boot). A foreign container
  mounting the volume reads only ciphertext. Honest boundary: compromise of *this*
  container (env + memory readable) defeats the encryption — true for anything that holds
  tokens server-side. The store keeps only the **hash** of each Ratatoskr token, so even a
  full store-plus-key leak cannot reproduce a client credential.
- **The Ratatoskr token is deliberately non-expiring, mitigated by revocability.** Like
  the streamer API key (mitigated by scope), this is a considered trade-off, not an
  oversight: the token is opaque (no offline structure), 256-bit random, carried only in
  `Authorization` headers over pinned TLS, hash-stored server-side, Keystore-backed on the
  device, and dead the instant its session entry is deleted. Revocation-by-lookup is
  strictly stronger than revocation-by-expiry; the full threat comparison is in
  [ADR-0001](./adr/0001-client-auth-ratatoskr-native-sessions.md).

Hardening checklist (small items, still binding):

- Validate and URL-encode client-supplied path parameters (`itemId`) before they enter
  upstream URLs.
- `/health` stays unauthenticated but reports only coarse reachability — no versions,
  no URLs. The Sonos state is the last background probe's outcome (the endpoint never waits
  on SSDP); before the first probe settles it reports `detail: "probing, retry shortly"`, so
  a single post-startup check is distinguishable from an actual Sonos outage. A still-probing
  Sonos also does not drag the overall `status` to `degraded` on its own — only a *confirmed*
  unreachable Sonos does — so the probing window cannot false-alarm a monitor that only reads
  `status` (`api/service.ts`). The first probe is also kicked off in the background at startup
  (`main.ts`), not only on the first `/health` call, so a readiness check landing shortly after
  boot has a head start on that window rather than starting it from zero.
- No CORS headers (the API is not for browsers); bearer-token auth means no cookie-based
  CSRF surface.
- Commit the lockfile; run `npm audit` in CI.
- The container runs as a non-root user.

Known accepted risks / open points:

- The streamer API key in the media URL remains readable on the LAN (UPnP, HTTP sniffing,
  ABS access logs). Accepted: it is minimally privileged (a stream-only, read-only account),
  so a leak grants at most read/stream of the library — not the listener's account, and no
  writes. It is long-lived rather than short-lived (an API key can't be exchanged for a
  short-lived token, and the URL must survive a multi-hour book), so the leak window is not
  time-bounded; the mitigation is scope, not expiry.
- The Ratatoskr → Audiobookshelf transport carries per-user credentials (login) and tokens
  (library, and the phase-4 streamer identity), so it is hardened rather than left to chance:
  `ABS_URL` should be `https://` and defaults to requiring it — plain HTTP needs the explicit
  `ABS_ALLOW_PLAIN_HTTP=true` opt-out (trusted LAN / reverse-proxy TLS). Self-signed or
  private-CA ABS certificates are trusted by pinning the PEM (`ABS_CA_CERT_PATH` / `ABS_CA_CERT`,
  verification stays on); `ABS_TLS_INSECURE=true` is an explicit, discouraged last resort that
  disables verification. Ratatoskr also probes `ABS_URL` at startup and refuses to boot if the
  host answers but is not Audiobookshelf, so a misconfiguration fails loud instead of leaking
  credentials to the wrong host. (This is a fingerprint check, not authentication — the real
  guarantee against an impostor/MITM is HTTPS with a verified certificate.)
- Refresh-token rotation across two consumers: resolved by decision, pending
  implementation. The shared-chain model (contract 1.1.0 handover through
  `Session.rotatedTokens`) proved structurally fragile — repeated silent re-logins and
  second-order bugs — and is replaced by Ratatoskr-native sessions under `/v2`
  ([ADR-0001](./adr/0001-client-auth-ratatoskr-native-sessions.md), section 8): the server
  is the sole holder of ABS chains, one per device, so no rotating token ever has two
  consumers again. The handover protocol remains live on the frozen `/v1` surface until
  its sunset.
- `/health` is unauthenticated and currently triggers one upstream Audiobookshelf request
  per call, so a poller (or a hostile LAN device) amplifies 1:1 into ABS load. Deferred:
  cache the dependency status for a short TTL once the polling/reachability patterns exist
  in phase 4/5, rather than building caching infrastructure without that context.

## 15. Next steps

Planned work, not yet built. Captured here so the intent is not lost; each lands in its
own change with its own tests.

- **Integration test against a real Audiobookshelf.** *(Done.)* The `abs/` client was
  previously covered only against `fetch` stubs, so it verified our own parsing but not that
  the request/response shapes match a live ABS. Added a Docker-gated integration test
  (now `packages/integration-tests/test/absLive.integration.test.ts`) that boots a real,
  digest-pinned Audiobookshelf in a container, seeds it, spawns the compiled server against
  it, and drives the library projection over the contract's version prefix. It skips cleanly where
  no container runtime is available and runs in CI. This closed the phase-3a open item — a
  smoke test against a live ABS before phase 4 builds playback on top of the projection —
  and on its first run surfaced a real drift bug: the client read the ABS token pair from the
  top level of the login/refresh response, but ABS 2.26+ nests it under `user`; fixed in
  `toAuthTokens`.
- **Bundle the server for a smaller deploy artifact.** The build is currently `tsc`-only:
  it emits per-file JavaScript and ships `node_modules` into the container. Introduce a
  bundling step (e.g. esbuild or rollup) that tree-shakes the server (`packages/app`) into
  a single artifact with dead code eliminated, to shrink the container image and speed
  startup. Must stay compatible with the single multi-stage, multi-arch Dockerfile
  (section 12) and must not pull generated contract types/schemas out of their normal
  module boundary (section 11).

## 16. Planned features (post-v1)

Post-v1 ideas live in the [issue tracker](https://github.com/Xexanos/ratatoskr-server/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement),
not in this document, so the backlog sits in one place and each item can be prioritized and
closed independently. They remain **not commitments** — captured so the reasoning is not lost
and so the v1 design does not *actively prevent* them (section 2). Each would land as its own
change, with its own contract version bump where the API is affected. This differs from
section 15 (near-term work already lined up); this section is the longer horizon. The app SPEC's
section 14 (Planned features) points at the same tracker for the app-side counterparts.
