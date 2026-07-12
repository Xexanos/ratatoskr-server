// Sonos transport times are `H:MM:SS` strings (used by Seek REL_TIME and reported by
// GetPositionInfo's RelTime). Small pure converters between those and whole seconds.
//
// Deliberate copy of packages/app/src/sonos/time.ts: the double must not reach into app
// internals (and the app must not depend on a test package). Both sides implement the same
// SPEC section 4 time format, so they cannot drift apart in behavior.

export function secondsToHms(totalSeconds: number): string {
  const clamped = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds) : 0
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const seconds = clamped % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}`
}

// Parse `H:MM:SS` (Sonos also emits values like `NOT_IMPLEMENTED` or empty for some fields —
// those parse to 0, which is the safe floor for a position).
export function hmsToSeconds(value: string): number {
  const parts = value.split(':')
  if (parts.length !== 3) return 0
  const [h, m, s] = parts.map((part) => Number(part))
  if (![h, m, s].every((n) => Number.isFinite(n))) return 0
  const total = (h as number) * 3600 + (m as number) * 60 + (s as number)
  return total > 0 ? total : 0
}
