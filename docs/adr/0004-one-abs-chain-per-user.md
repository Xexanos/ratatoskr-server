# One ABS chain per user, shared by every device

Decided in issue [#165](https://github.com/Xexanos/ratatoskr-server/issues/165) (2026-07). Supersedes
the **"One ABS chain per device login, never shared"** decision of
[ADR-0001](./0001-client-auth-ratatoskr-native-sessions.md): the store still keeps one entry per
device, but every device of one Audiobookshelf user now shares a single ABS chain rather than
holding its own. Everything else ADR-0001 decided (the Ratatoskr-native opaque token, the encrypted
store, the keep-alive loop, the rare-and-loud dead-chain failure) stands.

## Context

Issue #165 started narrow: on-demand chain refreshes from the request path did not wait out the
inter-refresh gap (`CHAIN_SPACING_MS`) against each other, so two devices of one user whose access
tokens expired together could trigger two refreshes inside the same second. Below Audiobookshelf
2.35.1 that is the identical-refresh-token collision ADR-0001's amendment describes
([advplyr/audiobookshelf#5253](https://github.com/advplyr/audiobookshelf/issues/5253)): two refreshes
of one user in one second come back with the same token string, and the two chains merge.

The gap was the mitigation ADR-0001 reached for. Grilling the fix surfaced the question underneath
it: *why do two chains of one user exist at all?* They exist only because ADR-0001 made the chain
per device. But the app never needed a distinct upstream session per device; it needed the user to
stay signed in. If the server keeps exactly **one** chain per user and every device rides it, the
two-refreshes-of-one-user case cannot arise, and the gap it required has nothing left to guard.

Grounding facts are unchanged from ADR-0001 (ABS rotates the refresh token in place; the refresh
window slides; below 2.35.1 the refresh token is minted from second-precision timestamps with no
per-session claim). Nothing is deployed yet, so there is no stored data to migrate.

## Decision

**One ABS chain per ABS user, shared by all of that user's device logins.** The session store keeps
two things: one *device row* per sign-in (token hash, ABS user id, created-at) and one *chain* per
user (the access/refresh pair, when it was last refreshed, whether it has died). A device row
references its user's chain; the chain is created with the user's first device and removed with the
last (reference-counted).

- **Sign-in still validates against Audiobookshelf.** Login is not replaced by a local
  password-hash comparison (see rejected options): the password is proved against ABS on every
  sign-in, exactly as before, and is stored nowhere.
- **The chain a sign-in mints is kept only when the user had none live.** A first sign-in installs
  it; a sign-in after the user's chain died replaces it, *healing every device that shared it at
  once*; a sign-in while the user already has a live chain keeps that one and ends the freshly minted
  ABS session upstream (a throwaway that existed only to prove the password). Ending it is
  best-effort, for the same reason retiring a replaced token is: the new Ratatoskr token is already
  live.
- **Sign-out ends the ABS session upstream only for the user's last device.** While another device
  still rides the chain, sign-out deletes the device row and leaves the chain alone; the last device
  out takes the chain with it and its ABS session is ended. The Ratatoskr token is dead immediately
  either way.
- **The keep-alive loop renews per user, not per device.** One refresh serves every device of a
  user, and the in-flight dedup is keyed by user id. Because a user has exactly one chain, no two
  refreshes of one user can overlap or race, so **`CHAIN_SPACING_MS` and the whole inter-refresh
  spacing mechanism are removed.**
- **A dead chain still keeps its devices** (ADR-0001's rare-and-loud failure), so their next request
  answers `UPSTREAM_SESSION_LOST` rather than "signed out". The difference is the heal: the first
  device of the user to sign in again replaces the dead chain, and every other device resumes on the
  new pair without a re-login of its own.

## Consequences

- **The collision is gone by construction, not by timing.** The mitigation ADR-0001 needed (space
  every schedule's refreshes over a second) is deleted rather than extended to the request path,
  which is what #165 would otherwise have required.
- **Admin revocation is coarser, deliberately.** Revoking a user's ABS session upstream now forces
  every device of that user to re-authenticate, where per-device chains could (on ABS >= 2.35.1) have
  taken down one device. Accepted, and arguably an operator convenience: one revocation is enough to
  make Ratatoskr re-prompt the user, rather than one per device. Per-device revocation, if it is ever
  wanted, belongs to the planned operator session-list feature on the Ratatoskr side, not to the ABS
  chain.
- **A user's chain death hits all their devices together.** This was already the dominant case under
  ADR-0001 (an outage past the refresh window, or a rename, kills all of a user's chains at once);
  now it is the only case. The heal makes recovery cheaper than before: one re-login, not one per
  device.
- **A residual, accepted micro-risk on ABS < 2.35.1.** A sign-in mints a throwaway ABS session even
  when the user already has a live chain. If that mint lands in the same second as a refresh of the
  user's chain (or a second simultaneous sign-in of the same user), the throwaway token can equal the
  live chain's token, and ending the throwaway would then end the live chain. This needs two events
  of one user inside one second on an Audiobookshelf older than 2.35.1, which is vanishingly rare and
  self-limited to outdated servers. Spacing the login path was considered and rejected as
  disproportionate to that risk (see below); the failure, if it ever happens, is the ordinary
  dead-chain one, and the next sign-in heals it.
- **No migration.** Nothing is deployed, so the store format changes freely to the two-list
  (devices + chains) shape.

## Considered options

- **Keep per-device chains and space the request path too** (the original #165 fix, PR #170,
  superseded): the smaller change, and correct, but it keeps the per-user collision permanently
  possible and merely mitigated, and leaves `CHAIN_SPACING_MS` as standing machinery motivated by a
  bug that ABS 2.35.1 already fixed. This decision removes the possibility instead of pacing around
  it.
- **Compare a stored hash of the username/password instead of calling ABS at sign-in** (rejected):
  it would let a re-login reuse the existing chain without an ABS round-trip, but it reopens
  precisely what ADR-0001 closed. A password-derived hash is offline-crackable material at rest (a
  different risk class than a revocable token), a changed ABS password would keep validating the old
  one (a security hole, since a password change is the remediation for a leak), and a user disabled
  in ABS would keep signing in locally. Login stays an ABS call.
- **Space the login path against the last refresh** (rejected): closes the residual micro-risk above
  at the cost of adding request-path latency and a spacing clock back, to guard a case that needs two
  events of one user within one second on an unsupported-soon ABS version. Not worth it; the risk is
  accepted instead.
