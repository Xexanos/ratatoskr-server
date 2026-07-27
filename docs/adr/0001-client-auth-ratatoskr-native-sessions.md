# Client auth: Ratatoskr-native sessions — the server is the sole holder of ABS tokens

Decided in issue [#125](https://github.com/Xexanos/ratatoskr-server/issues/125) (2026-07,
wayfinder effort [#120](https://github.com/Xexanos/ratatoskr-server/issues/120)), replacing
the shared-ABS-token-pair model and its refresh-token rotation-handover protocol
(contract 1.1.0, SPEC section 8). The app-side counterpart is app SPEC section 5, which
references this ADR.

## Context

App and server shared one Audiobookshelf (ABS) token pair: the app logged in, handed its
refresh token to the server at `startSession`, and the server handed rotated pairs back
through `Session.rotatedTokens`. Because ABS rotates the refresh token on every use, the
two parties were consumers of one rotating chain — the handover protocol existed only to
paper over that. It produced repeated silent re-logins (the adoption window is ~300 s wide
in practice, [ratatoskr-app#105](https://github.com/Xexanos/ratatoskr-app/issues/105)) and
real second-order bugs
([ratatoskr-app#108](https://github.com/Xexanos/ratatoskr-app/issues/108)).

Hard requirement for the redesign: **the user stays signed in until an explicit sign-out.**
Server restarts and arbitrarily long usage pauses must never force a re-login.

Grounding facts (code-verified against ABS v2.26.0,
[#121](https://github.com/Xexanos/ratatoskr-server/issues/121)): each ABS login creates an
independent session with its own refresh chain; refresh rotates in place (continues, never
forks); the refresh window slides (default 7 days) and dies after any longer pause; the
only indefinite ABS credentials are admin-created API keys. No surveyed open-source ABS
client stores the password; all force a re-login once the refresh window lapses
([#127](https://github.com/Xexanos/ratatoskr-server/issues/127)).

## Decision

**Variant A — Ratatoskr-native sessions**
([#122](https://github.com/Xexanos/ratatoskr-server/issues/122)):

- The app posts ABS credentials once at sign-in; the server validates them against ABS and
  issues its own credential. The server is the sole holder of ABS token pairs — no two
  parties ever share a rotating chain again, so the entire handover protocol disappears
  structurally.
- **One ABS chain per device login, never shared.** Each sign-in creates one store entry:
  Ratatoskr token *hash*, its own ABS chain, metadata.
- **The Ratatoskr credential is an opaque 256-bit token — non-expiring, revocable.** The
  server stores only its hash; validation is an in-process lookup (replacing the token
  guard's per-request ABS roundtrip). No expiry and no rotation: a rotating pair would
  reintroduce the bug class this decision kills, and a sliding expiry would violate the
  hard requirement. JWTs were rejected: sign-out must revoke immediately, which needs a
  store lookup anyway, so a JWT adds key management while saving nothing.
- **Encrypted persisted session store**: a single AES-256-GCM file on the existing mounted
  volume, file mode 0600, non-root. The key is operator-supplied and mandatory
  (`SESSION_STORE_KEY`, Docker-secret-compatible via `SESSION_STORE_KEY_FILE`); no key →
  the server refuses to boot. This consciously relaxes the former "no database" constraint
  (SPEC section 11) — persistence is what closes the restart hole.
- **Keep-alive** so chains outlive any pause: daily jittered refresh of every stored chain,
  refresh-on-boot for stale chains, on-demand refresh mid-use. A chain now dies only if
  server↔ABS contact is lost for the entire refresh window (≥ 7 days by default) or on an
  ABS username change.
- **Failure mode is rare and loud**: a dead chain answers the next request with 401 +
  machine-readable `code: "UPSTREAM_SESSION_LOST"`; the app shows a targeted password
  prompt. Re-login creates a fresh chain and a new token (no in-place repair).
- **Sign-out is full-depth and per device**: delete the store entry (token dead
  immediately) plus best-effort ABS `POST /logout` for exactly this device's chain;
  idempotent, still 204 if ABS is unreachable.
- **The app stores only the Ratatoskr token** (Keystore-backed), plus server URL, TLS
  fingerprint, and display username. ABS tokens and the entire adoption logic of app SPEC
  section 5 drop. The user's ABS password is never stored — on either side.

## Considered options

- **Variant B — separate ABS sessions for app and server**
  ([#123](https://github.com/Xexanos/ratatoskr-server/issues/123), rejected): double login
  at sign-in; the app keeps its own ABS chain alive via exp-aware background refresh. Kills
  the shared chain, but drags in nearly all of A's server-side substructure (encrypted
  store, keep-alive) while keeping the token guard a per-request ABS roundtrip — and keeps
  the dominant failure term A eliminates: device inactivity past the refresh window still
  forces a re-login, so the hard requirement is met *mostly, never guaranteed*. Two
  independent death paths per device double the failure matrix; the app-side no-password
  keep-alive has no ecosystem precedent.
- **Variant C — hardened status quo**
  ([#124](https://github.com/Xexanos/ratatoskr-server/issues/124), rejected): the
  persistence-free ceiling. Hardening stretches the ~300 s adoption window to "session
  lives, server up", but two structural residuals are unfixable without persistence: a
  server restart with a pending pair strands the device (a standing violation of the hard
  requirement, hit by ~every deployment that restarts during playback), and device
  inactivity past the refresh window. C removes nothing and ends up the most
  protocol-complex of the three.
- **Per-user ABS API keys** (out of scope by map decision): admin-or-up creation only —
  operators would hand-provision a key per user; unusable as a self-service login path.
- **OIDC/OAuth delegation** (out of scope by map decision): ends in the same ABS
  access/refresh pair, so it inherits the same rotation problem while adding an IdP
  dependency this self-hosted, LAN-first deployment does not have.
- **Storing the ABS password to silently heal dead chains** (rejected in #122/#127): a
  password at rest is a different risk class than a revocable token (a leaked password is
  the account, unrevocable), and no surveyed client does it. The dead-chain case is rare
  enough that a targeted prompt is acceptable.

## Security rationale

Compared per threat in [#125](https://github.com/Xexanos/ratatoskr-server/issues/125);
where the variants differ, A leads:

- **Device theft** (the largest real delta): A alone leaves **no ABS tokens on the
  device**; the stolen credential is Ratatoskr-scoped and centrally revocable the instant
  its store entry is deleted. B and C leave a live, self-renewing ABS refresh chain on the
  device, revocable only by ABS-admin intervention.
- **The non-expiring bearer, challenged and held**: rotation/expiry is a *substitute* for
  revocability under stateless validation — JWTs must expire because they cannot be taken
  back. A's token is the inverse: opaque, hash-stored, validated by per-request lookup, so
  revocation is immediate — strictly stronger than expiry. The snapshot-leak channels
  rotation actually protects against are closed one by one: `Authorization`-header-only
  over pinned TLS (no query strings), normative log redaction, hash-only storage
  server-side (even a full store + key leak cannot reproduce the app credential), Keystore
  at rest, 256-bit entropy. Against persistent compromise rotation is useless anyway.
  Device-ID binding was considered and rejected (a device ID is not a secret and rides the
  same channel); hardware-key request signing is out of proportion behind pinned TLS.
- **Server compromise**: identical across variants at runtime (whoever owns the container
  reads env + memory). At rest A = B: ciphertext-only without `SESSION_STORE_KEY`.
- **Sign-out propagation**: full depth per device in A; a store leak captured before
  sign-out yields ABS tokens that are *revoked* at sign-out, not just forgotten.
- Precedent for a deliberately non-expiring credential: `ABS_STREAMER_API_KEY` (SPEC
  section 14), mitigated by scope; this one is mitigated by revocability.

Follow-up noted in #125 (a feature on top of the model, not a design change): an operator
session list with per-device sign-out and device metadata, answering the residual of
silent token exfiltration.

## Contract impact (named, not implemented — decided in [#128](https://github.com/Xexanos/ratatoskr-server/issues/128))

- **Breaking cut: contract 2.0.0 under `/v2`.** The prefix lives in one place
  (`servers.url`). The oasdiff CI job takes its one-time breaking-change flag at the cut.
- **`/v1` transition window**: `/v1` stays served in parallel, frozen at the **1.4.0 git
  tag** (the tag *is* the freeze; no second contract file). It may be removed in the first
  release ≥ 1 month after the `/v2` app is published; the removal commit is `feat!:`, so
  the server major falls out automatically. After sunset, every `/v1` route answers from an
  unauthenticated catch-all **410 Gone** with the contract error shape, code
  `UPGRADE_REQUIRED`, and a "please update the app" message — indefinitely.
- **Removed without deprecation markers** (2.0.0; `/v1` clients read the frozen tag):
  `POST /auth/refresh`, `Session.rotatedTokens`, the `RotatedTokens` schema,
  `StartSessionRequest.refreshToken`, and the stopSession 200-with-final-Session case —
  **`stopSession` responds 204** always.
- **Changed/added**: `POST /auth/login` returns the Ratatoskr token instead of an ABS
  pair; `POST /auth/logout` (new, bearer-protected, 204, idempotent); the 401 error body
  gains the machine-readable `UPSTREAM_SESSION_LOST` code.
- **The new app is `/v2`-only** (no dual-stack — that would keep the adoption logic alive
  with a doubled test matrix). Rollout order is softly enforced: on 404 against `/v2` the
  app shows a targeted "please update your server" prompt. Migration is a **one-time
  re-login**: stored ABS tokens are discarded on first start after the update; server URL,
  TLS fingerprint, and username survive. Chain-adoption migration was rejected as one more
  race-prone token handover for a one-time moment.

Implementation is a follow-up effort (tracked outside this ADR); this document records the
target design and why.
