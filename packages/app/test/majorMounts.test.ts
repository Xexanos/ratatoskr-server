import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp } from '../src/api/app.js'
import type { SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { testConfig } from './helpers/testConfig.js'

// Where the two served majors are pinned *against each other* (SPEC section 6). The per-major route
// behavior is covered by the route tests, which all speak /v1; what only shows up with both mounts
// registered is the boundary — that an operationId two documents share does not get one major's
// handler on the other's surface, that what 2.0.0 dropped is gone from /v2 and still there on /v1,
// and that a URL handed out under one mount never points into the other.

const AUTH = { authorization: 'Bearer user-token' }
const TOKENS = { accessToken: 'a', refreshToken: 'r', user: { id: '42', username: 'lars' } }
const BOOK = { id: 'li_1', title: 'Alpha', author: undefined, durationSeconds: 300, hasCover: true, progress: undefined }
const DOMAIN_SESSION = {
  itemId: 'li_1',
  item: BOOK,
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
  rotatedTokens: undefined,
}
const ROTATED = { accessToken: 'new-access', refreshToken: 'new-refresh' }

function appWith(abs: Partial<AbsClient> = {}, sessions: Partial<SessionManager> = {}) {
  return buildApp(testConfig(), {
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sonosClient: { isReachable: vi.fn().mockResolvedValue(true) } as unknown as SonosClient,
    sessionManager: sessions as SessionManager,
  })
}

describe('both majors are served from one process', () => {
  afterEach(() => vi.restoreAllMocks())

  it('answers /health on each mount', async () => {
    const app = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    for (const prefix of ['/v1', '/v2']) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/health` })
      expect(res.statusCode, prefix).toBe(200)
      expect(res.json().status, prefix).toBe('ok')
    }
    await app.close()
  })

  it('serves neither major at the unprefixed path', async () => {
    const app = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

// The reason the /v1 surface lives in its own service rather than in the shared one. Both documents
// declare `login` at POST /auth/login, so an inherited proxy would answer /v2's login with an
// Audiobookshelf token pair — an upstream credential on the device, under a contract that promises an
// opaque Ratatoskr token (ADR-0001). The assertion that matters is not the status code but that ABS
// is never asked.
describe('the /v2 auth surface is not the /v1 one', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not proxy Audiobookshelf credentials on /v2/auth/login', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ login })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })

  it('still proxies on /v1/auth/login — the frozen major is untouched by the second mount', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ login })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TOKENS)
    expect(login).toHaveBeenCalledWith('lars', 'secret')
    await app.close()
  })

  it('has no refresh route on /v2 and does not reach ABS for one', async () => {
    const refresh = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ refresh })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: { refreshToken: 'r' } })
    expect(res.statusCode).toBe(404)
    expect(refresh).not.toHaveBeenCalled()
    await app.close()
  })

  // logout is declared by 2.0.0 and implemented by nothing yet (#134), so glue's resolver falls back
  // to the not-implemented stub. /v1 never declared the route at all — same status, different reason.
  it('answers /v2/auth/logout as not implemented, and /v1/auth/logout as unknown', async () => {
    const app = await appWith()
    const v2 = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: AUTH })
    const v1 = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: AUTH })
    expect(v2.statusCode).toBe(404)
    expect(v1.statusCode).toBe(404)
    await app.close()
  })
})

describe('a cover URL carries the prefix of the mount that produced it', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['/v1', '/v1/library/items/li_1/cover'],
    ['/v2', '/v2/library/items/li_1/cover'],
  ])('mints %s cover URLs under %s', async (prefix, expected) => {
    const listItems = vi.fn().mockResolvedValue({ books: [BOOK], nextCursor: null })
    const app = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: `${prefix}/library/items`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0].coverUrl).toBe(expected)
    await app.close()
  })
})

// The rotation handover is 1.4.0's protocol and 2.0.0 dropped every part of it (SPEC section 8).
describe('the rotation handover reaches /v1 only', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts a refresh token at start on /v1 and passes none on /v2', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const app = await appWith({}, { start })
    const payload = { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'r' }

    await app.inject({ method: 'PUT', url: '/v1/sessions/current', headers: AUTH, payload })
    expect(start).toHaveBeenLastCalledWith('user-token', 'r', 'li_1', 'RINCON_1')

    await app.inject({ method: 'PUT', url: '/v2/sessions/current', headers: AUTH, payload })
    expect(start).toHaveBeenLastCalledWith('user-token', undefined, 'li_1', 'RINCON_1')
    await app.close()
  })

  it('hands a pending pair to a stopping /v1 client, and answers /v2 with 204', async () => {
    const stop = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, state: 'stopped', rotatedTokens: ROTATED })
    const app = await appWith({}, { stop })

    const v1 = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(v1.statusCode).toBe(200)
    expect(v1.json().rotatedTokens).toEqual(ROTATED)

    const v2 = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: AUTH })
    expect(v2.statusCode).toBe(204)
    expect(v2.body).toBe('')
    await app.close()
  })

  // Through a real route, both halves at once: /v1 delivers a pending pair and /v2 cannot. Nothing
  // here relies on Fastify's serializer dropping a field 2.0.0's schema omits — only the /v1 service
  // maps the pair onto a response at all (contractMapping.ts) — but a route test is what proves the
  // right service is behind the right mount.
  it('never puts a rotated pair on a /v2 session response', async () => {
    const current = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, rotatedTokens: ROTATED })
    const app = await appWith({}, { current })

    const v1 = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(v1.json().rotatedTokens).toEqual(ROTATED)

    const v2 = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: AUTH })
    expect(v2.statusCode).toBe(200)
    expect(v2.json()).not.toHaveProperty('rotatedTokens')
    await app.close()
  })
})

// #134 replaces /v2's bearer with an opaque Ratatoskr token resolved to a stored ABS chain. That
// changes methods the two majors share, so this pins the half that must not move: on /v1 the token
// the caller sent is the token ABS sees.
describe('/v1 forwards the caller own bearer upstream', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes the request bearer to ABS unchanged', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })
    const app = await appWith({ listItems })
    await app.inject({ method: 'GET', url: '/v1/library/items', headers: { authorization: 'Bearer abs-access' } })
    expect(listItems).toHaveBeenCalledWith('abs-access', { searchQuery: undefined, limit: 50, cursor: undefined })
    await app.close()
  })
})
