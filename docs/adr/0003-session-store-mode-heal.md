# Session store file mode: heal to 0600 at open, warn, never block boot

Decided in issue [#167](https://github.com/Xexanos/ratatoskr-server/issues/167) (2026-07).
`SessionStore.open` re-asserts the store file's mode 0600 at boot - the **mode heal** (see
CONTEXT.md) - instead of trusting the mode the file was created with.

## Context

Mode 0600 on the session store file (ADR-0001, SPEC section 8) was enforced only when the
atomic-write path created a temp file, so a pre-existing store whose mode had been widened
stayed group/other-accessible until the next mutation rewrote it - a standing invariant
that was, in fact, only a creation-time property.

## Decision

- **Heal and warn.** On POSIX, when the pre-existing store file has any group or other
  permission bit set (`mode & 0o077`), `open` chmods it back to exactly 0600 and emits a
  warning. Boot proceeds.
- **A failed heal also warns and continues**, with a distinct message ("could not restore",
  not "restored"). The classic cause is a root-driven restore leaving the file root-owned,
  where chmod by the server's uid fails with EPERM - the state is self-limiting anyway,
  because the next mutation rewrites the file as a fresh 0600 temp owned by the server,
  renamed over the path.
- **A narrower mode is left alone.** 0400 exposes nothing, and the server never needs write
  permission on the file itself (atomic replace only renames over it, which is directory
  permission). "Healing" it to 0600 would widen a file against the operator's intent.
- **POSIX-only.** Windows ignores the mode argument on file creation, so the check is a
  no-op there (`process.platform === 'win32'`), matching the mode test that is skipped on
  Windows for the same reason.
- **The warning is injectable, never silent.** `SessionStoreOptions.onWarning` defaults to
  `console.warn`; `buildApp` passes the app logger. The default exists so a forgotten wire
  cannot quietly degrade this decision to a silent chmod.

## Considered options

- **Refuse to start (rejected)**: consistent with no-key-no-boot, but disproportionate and
  hostile to the likeliest widening cause. The exposure is ciphertext plus size/mtime - the
  key lives in env/Docker secret, never on the volume, so 0600 is the second defence layer,
  not the first. And the realistic path to a widened mode is not an operator's deliberate
  chmod but a backup/restore cycle (`cp` or `tar` without `-p` applies the umask, typically
  0644), which means refusal bricks the appliance exactly when the operator is restoring it.
  The store already ruled once that stopping the server from booting is worse than the
  misconfiguration guarded against (the rejected lock file, sessionStore.ts).
- **Warn only (rejected)**: leaves the window open for no reason. The server created the
  file at 0600 and owns its invariant; re-asserting it is not overreach.
- **Silent chmod (rejected)**: the operator never learns that their restore procedure (or a
  tampering attempt) keeps widening the file, and the server silently fights anyone who
  widened it deliberately.
