// Read an Audiobookshelf access token's `exp` (seconds since the epoch) WITHOUT verifying the
// signature — only the timing is needed, to renew before expiry, and ABS is the authority on
// validity. Returns undefined for a non-JWT / unparseable token, so a caller degrades to "no
// proactive renewal" rather than guessing.
//
// Shared by the two places that renew on a clock: the /v1 sync loop's rotation handover
// (playback/sessionManager.ts) and the /v2 keep-alive's on-demand refresh (auth/keepAlive.ts).
export function jwtExpSeconds(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}
