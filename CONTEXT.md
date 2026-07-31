# Ratatoskr server

Bridge between an Audiobookshelf (ABS) server and Sonos speakers: browse the library, pick a
speaker, control the single active playback session. ABS is the single source of truth for
progress; the OpenAPI contract is the single source of truth for the client API.

## Language

### Auth

**Ratatoskr token**:
The opaque 256-bit value a `/v2` client sends as its bearer, minted at sign-in and valid until
sign-out. Not an ABS credential and never exchangeable for one: the server stores only its hash
and is the sole holder of the ABS tokens behind it (ADR-0001).
_Avoid_: access token, session token, API key — each names something else in this codebase.

**Device session**:
One sign-in, as the server holds it: a store entry pairing the Ratatoskr token's hash with the
identified ABS user, whose **ABS chain** (an access/refresh pair) it rides. The chain is **one per
ABS user, shared by every device of that user** (ADR-0004): the store keeps one entry per device but
one chain per user, created with the user's first device and ended with the last. `AuthService` owns
the entry's lifecycle; `SessionStore` persists both.
_Avoid_: session, playback session — "session" alone means the one active playback in this
codebase, which is a different thing entirely; qualify it (`device session`, `auth session`)
whenever both could be meant.

**Shared chain**:
The single ABS access/refresh pair Ratatoskr holds per ABS user, that all of the user's device
sessions run on (ADR-0004, issue #165). The keep-alive loop renews it once for the whole user, a
sign-in reuses or heals it rather than opening a second, and a sign-out ends it upstream only when
the user's last device goes. Replaces ADR-0001's per-device chain; the reason there is no
inter-refresh spacing to guard the ABS < 2.35.1 identical-token collision (a user has exactly one
chain, so two refreshes of one user cannot race).
_Avoid_: per-device chain (superseded), chain spacing (the spacing is gone with the per-device chain).

**Token guard**:
The one place (`packages/app/src/api/tokenGuard.ts`) that enforces the invariant *every
bearer-protected operation proves the caller's bearer before acting*. Wraps each resolved
operation handler in `buildApp`; derives the bearer-protected set from the contract, so a new
operation is guarded by default, and throws at startup on a stale exemption. Exists because the
bearer security handler checks for **presence only**. What *proving* means is the major's, not
the guard's: an upstream call on `/v1`, an in-process store lookup on `/v2` — which is also what
hands the handler the chain it acts on.
_Avoid_: auth middleware, validation interceptor

**Self-validating operation**:
A bearer-protected `/v1` operation whose handler forwards the caller's token to ABS as part of
its real work, so an invalid token 401s upstream without the token guard's help — the guard's
exemption list (`SELF_VALIDATING_OPERATIONS`), one justification per entry. Meaningless on `/v2`,
where no handler forwards the caller's bearer upstream at all.
_Avoid_: unguarded (a self-validating operation still validates — just not via the guard),
allowlisted

**Unknown-token-tolerant operation**:
A bearer-protected operation that answers normally when the bearer names no session, and so is
exempt from the guard on `/v2` (`UNKNOWN_TOKEN_TOLERANT_OPERATIONS`, one justification per entry).
Currently only sign-out, which the contract makes idempotent so a client can always complete a
sign-out locally.
_Avoid_: unguarded, allowlisted, public (it still requires a bearer — just not a live one)

**Mode heal**:
The boot-time re-assertion of the session store file's owner-only mode: when a pre-existing
store has any group/other permission bit set, `SessionStore.open` chmods it back to 0600 and
warns - never a boot blocker, and a failed chmod only warns too (ADR-0003). POSIX-only; a
no-op on Windows, where the mode does not apply.
_Avoid_: permission enforcement, chmod guard - both suggest refusing to boot, which this
deliberately is not.

### Versioning

**Contract tag**:
The immutable git tag `contract-<x.y.z>` naming the byte-exact text of one contract version
(`info.version` in `contract/openapi.yaml`). An *identity* statement — what a client pins against,
and what a frozen major is served from — cut automatically on push to `main` (`contract-tag.yml`)
and never moved.
_Avoid_: release tag, version tag — those name the `v<x.y.z>` **image release**, a *certificate*
that bytes passed E2E, cut by a different pipeline (`promote.yml`). A `contract-*` tag certifies
nothing about a running server; conflating the two is why a client once pinned `v1.4.0` (the image)
where it meant `contract-1.4.0` (the contract).
