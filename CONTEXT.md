# Ratatoskr server

Bridge between an Audiobookshelf (ABS) server and Sonos speakers: browse the library, pick a
speaker, control the single active playback session. ABS is the single source of truth for
progress; the OpenAPI contract is the single source of truth for the client API.

## Language

### Auth

**Token guard**:
The one place (`packages/app/src/api/tokenGuard.ts`) that enforces the invariant *every
bearer-protected operation proves the caller's token against ABS before acting*. Wraps each
resolved operation handler in `buildApp`; derives the bearer-protected set from the contract,
so a new operation is guarded by default, and throws at startup on a stale exemption. Exists
because the bearer security handler checks for **presence only** — ABS is the sole authority
on token validity.
_Avoid_: auth middleware, validation interceptor

**Self-validating operation**:
A bearer-protected operation whose handler forwards the caller's token to ABS as part of its
real work, so an invalid token 401s upstream without the token guard's help — the guard's
exemption list (`SELF_VALIDATING_OPERATIONS`), one justification per entry. Everything not on
that list is **guarded**: the token guard runs `validateToken` (a cheap authenticated ABS
call) before dispatch.
_Avoid_: unguarded (a self-validating operation still validates — just not via the guard),
allowlisted
