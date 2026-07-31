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
per-session claim). The `/v2` auth model has shipped (server
[#156](https://github.com/Xexanos/ratatoskr-server/pull/156)) and at least one server is deployed, so
a store already on disk in the old shape must be migrated on load rather than refused (see
Consequences).

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
  it; a sign-in after the user's chain died replaces it and **retires the user's other device rows**,
  so each of those devices re-authenticates once rather than being silently revived (see the
  revocation consequence below); a sign-in while the user already has a live chain keeps that one and
  ends the freshly minted ABS session upstream (a throwaway that existed only to prove the password).
  Ending it is best-effort, for the same reason retiring a replaced token is: the new Ratatoskr token
  is already live.
- **Sign-out ends the ABS session upstream only for the user's last device.** While another device
  still rides the chain, sign-out deletes the device row and leaves the chain alone; the last device
  out takes the chain with it and its ABS session is ended. The Ratatoskr token is dead immediately
  either way.
- **The keep-alive loop renews per user, not per device.** One refresh serves every device of a
  user, and the in-flight dedup is keyed by user id. Because a user has exactly one chain, no two
  refreshes of one user can overlap or race, so **`CHAIN_SPACING_MS` and the whole inter-refresh
  spacing mechanism are removed.**
- **A dead chain still keeps its devices** (ADR-0001's rare-and-loud failure), so their next request
  answers `UPSTREAM_SESSION_LOST` rather than "signed out" until they re-authenticate. The heal is
  deliberately bounded: the first device to sign in again replaces the dead chain and retires the
  user's other device rows, so each of those re-authenticates once. It does not silently revive them,
  which would reopen the revocation hole the retire closes (see Consequences).

## Consequences

- **The collision is gone by construction, not by timing.** The mitigation ADR-0001 needed (space
  every schedule's refreshes over a second) is deleted rather than extended to the request path,
  which is what #165 would otherwise have required.
- **Upstream revocation and password change stay effective remediations.** Because healing a dead
  chain retires the user's other device rows, a Ratatoskr bearer that rode a chain killed by a
  revocation is not silently re-armed by the owner's next sign-in: it reads as signed out and cannot
  act again. This carries forward ADR-0001's property that a re-login deleted the user's dead entries.
  An earlier draft of this ADR revived every device on heal instead; a security review flagged that as
  re-arming a stolen or revoked token (a lost phone locked out by a revocation would come back to life
  the moment the owner signed in), so the retire-on-heal behavior was restored. Revocation is per user,
  not per device: locking out one device re-prompts the user on all of theirs. Per-device lock-out, if
  wanted, is the planned operator session-list (SPEC section 16).
- **A user's chain death hits all their devices together, and each re-authenticates once.** An outage
  past the refresh window, or a rename, kills the user's one chain; every device meets
  `UPSTREAM_SESSION_LOST` and re-authenticates on its own next run. This is exactly ADR-0001's accepted
  post-outage UX. There is deliberately no cross-device auto-heal, since reviving the siblings is the
  revocation hole above.
- **A residual, accepted micro-risk on ABS < 2.35.1.** A sign-in mints a throwaway ABS session even
  when the user already has a live chain. If that mint lands in the same second as a refresh of the
  user's chain (or a second simultaneous sign-in of the same user), the throwaway token can equal the
  live chain's token, and ending the throwaway would then end the live chain. This needs two events
  of one user inside one second on an Audiobookshelf older than 2.35.1, which is vanishingly rare and
  self-limited to outdated servers. Spacing the login path was considered and rejected as
  disproportionate to that risk (see below); the failure, if it ever happens, is the ordinary
  dead-chain one, and the next sign-in heals it.
- **A stale refresh cannot bury a healed chain.** The keep-alive loop guards its write-back and its
  death mark with the refresh token it actually spent: a slow refresh whose chain a heal or another
  renewal overtook applies to nothing, rather than clobbering the successor or marking a now-live
  chain dead over a 401 for a token that had already been replaced.
- **A deployed store is migrated on load, not refused.** A file in the old single-list `{ entries }`
  shape is converted when opened: each user's live per-device chains collapse to the freshest one,
  every live device is preserved on it, and a device whose own chain had died is dropped (it
  re-authenticates, matching retire-on-heal); a user all of whose devices were dead keeps nothing. So
  an operator upgrading across this change keeps their signed-in devices (SPEC section 8's hard
  requirement) instead of hitting a `SessionStoreCorruptError` that refuses the boot. The store is
  rewritten in the two-list (devices + chains) shape on its first write thereafter.

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
- **Revive every device of the user on heal** (the first draft's auto-resume bonus, rejected): it
  re-arms every outstanding bearer of the user the moment the owner signs in again, including a stolen
  or revoked one, silently undoing an upstream revocation or password change while the operator
  session-list that could substitute for it does not yet exist. Retiring the user's other device rows
  on heal (each re-authenticates once) keeps revocation working, at the cost of the auto-resume
  convenience.
- **Refuse an old-shape store and require a manual wipe / `!` breaking release** (rejected): simpler
  in code, but it signs every device out on upgrade, the exact failure the persisted store exists to
  prevent. The on-load migration is small and keeps the hard requirement intact, so it wins.
