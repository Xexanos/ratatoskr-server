import type { components } from '@ratatoskr/contract'
import { AbsAuthError, AbsUpstreamError } from './errors.js'

type AuthTokens = components['schemas']['AuthTokens']

const REQUEST_TIMEOUT_MS = 10_000

// Client for the Audiobookshelf REST API. This slice covers authentication (SPEC section
// 8): Ratatoskr proxies login/refresh so the app only ever talks to Ratatoskr. Library
// and progress methods are added in the next slice.
export class AbsClient {
  constructor(private readonly baseUrl: string) {}

  // POST /login with `x-return-tokens: true` so a non-browser client gets the refresh
  // token in the body rather than only as an httpOnly cookie (ABS 2.26+).
  async login(username: string, password: string): Promise<AuthTokens> {
    const data = await this.postJson('/login', { 'x-return-tokens': 'true' }, { username, password })
    return toAuthTokens(data)
  }

  // POST /auth/refresh with the refresh token in the `x-refresh-token` header (ABS 2.26+).
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const data = await this.postJson('/auth/refresh', { 'x-refresh-token': refreshToken }, {})
    return toAuthTokens(data)
  }

  private async postJson(
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      // Network failure / timeout — never leak the URL (SPEC section 14).
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }

    if (res.status === 401) {
      await res.body?.cancel()
      throw new AbsAuthError()
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new AbsUpstreamError(`Audiobookshelf returned status ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new AbsUpstreamError('Audiobookshelf returned an unparseable response')
    }
  }
}

function toAuthTokens(data: unknown): AuthTokens {
  const d = data as { accessToken?: unknown; refreshToken?: unknown; user?: { id?: unknown; username?: unknown } }
  const accessToken = d?.accessToken
  const refreshToken = d?.refreshToken
  const user = d?.user
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !user) {
    // ABS answered 2xx but not in the shape we require (e.g. tokens not returned because
    // the x-return-tokens header was dropped by a proxy). Treat as an upstream fault.
    throw new AbsUpstreamError('Audiobookshelf did not return the expected tokens')
  }
  return {
    accessToken,
    refreshToken,
    user: { id: String(user.id), username: String(user.username) },
  }
}
