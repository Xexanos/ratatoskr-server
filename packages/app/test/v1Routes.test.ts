import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import type { SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { testConfig } from './helpers/testConfig.js'

// /v1 is contract 1.4.0, frozen at the contract-1.4.0 tag and served alongside /v2 until the sunset
// in ADR-0001. Installed app versions talk to it, so what these tests are for is the requirement that
// carries no code of its own: no behavior change. They cover the three things 2.0.0 dropped — the
// token proxies, the refresh token on startSession, and the rotation handover — plus the boundary
// between the two majors, since both are now mounted in one process.
const AUTH = { authorization: 'Bearer user-token' }
const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1', username: 'lars' } }
const ROTATED = { accessToken: 'access-2', refreshToken: 'refresh-2' }
const SESSION = {
  itemId: 'li_1',
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
}

function appWith(abs: Partial<AbsClient> = {}, sessions: Partial<SessionManager> = {}) {
  return buildApp(testConfig(), {
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sessionManager: sessions as SessionManager,
    sonosClient: {} as SonosClient,
  })
}

describe('POST /v1/auth/login', () => {
  afterEach(() => vi.restoreAllMocks())

  it('proxies the credentials to Audiobookshelf and returns the token pair', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ login })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'lars', password: 's3cret' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TOKENS)
    expect(login).toHaveBeenCalledWith('lars', 's3cret')
    await app.close()
  })

  it('needs no bearer token of its own', async () => {
    const validateToken = vi.fn()
    const app = await appWith({ login: vi.fn().mockResolvedValue(TOKENS), validateToken })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'lars', password: 's3cret' } })

    expect(res.statusCode).toBe(200)
    expect(validateToken).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/auth/refresh', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exchanges the refresh token upstream and returns the new pair', async () => {
    const refresh = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ refresh })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'refresh-0' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TOKENS)
    expect(refresh).toHaveBeenCalledWith('refresh-0')
    await app.close()
  })

  it('rejects a body without a refresh token as 400 in the contract Error shape', async () => {
    const app = await appWith({ refresh: vi.fn() })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'bad_request', message: expect.any(String) })
    await app.close()
  })
})

describe('the /v1 rotation handover', () => {
  afterEach(() => vi.restoreAllMocks())

  // The refresh token on startSession is what arms the handover: without it the sync loop cannot
  // renew, which is why 1.4.0 calls it "recommended". /v2 has no such field and passes undefined.
  it('hands the caller’s refresh token to the session, so the sync loop can renew', async () => {
    const start = vi.fn().mockResolvedValue(SESSION)
    const app = await appWith({}, { start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'refresh-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(start).toHaveBeenCalledWith('user-token', 'refresh-1', 'li_1', 'RINCON_1', '/v1')
    await app.close()
  })

  it('still starts a session when the client sends no refresh token', async () => {
    const start = vi.fn().mockResolvedValue(SESSION)
    const app = await appWith({}, { start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })

    expect(res.statusCode).toBe(200)
    expect(start).toHaveBeenCalledWith('user-token', undefined, 'li_1', 'RINCON_1', '/v1')
    await app.close()
  })

  // A pending pair rides along on every Session response until the client adopts it. The /v2 mount
  // drops the same field (sessionRoutes.test.ts) — the response schema of each major decides.
  it('delivers a pending rotated pair on the session', async () => {
    const current = vi.fn().mockResolvedValue({ ...SESSION, rotatedTokens: ROTATED })
    const app = await appWith({}, { current })
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ...SESSION, rotatedTokens: ROTATED })
    await app.close()
  })

  // stop() returns a final Session exactly when a pair was still pending — the last chance to deliver
  // it, since the tokens are discarded on stop.
  it('answers 200 with the final session when a pair was pending at stop', async () => {
    const final = { ...SESSION, state: 'stopped', rotatedTokens: ROTATED }
    const stop = vi.fn().mockResolvedValue(final)
    const app = await appWith({}, { stop })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(final)
    expect(stop).toHaveBeenCalledWith('user-token')
    await app.close()
  })

  it('answers 204 when nothing was pending', async () => {
    const app = await appWith({}, { stop: vi.fn().mockResolvedValue(undefined) })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    await app.close()
  })
})

describe('the /v1 library projection', () => {
  afterEach(() => vi.restoreAllMocks())

  // The one URL the API hands out that carries the mount prefix. A /v1 client must get /v1 here or it
  // is pointed at a major it does not know — see coverPathFor in abs/client.ts.
  it('asks for cover URLs under /v1', async () => {
    const listItems = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const app = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(listItems).toHaveBeenCalledWith('user-token', { searchQuery: undefined, limit: 50, cursor: undefined }, '/v1')
    await app.close()
  })
})

describe('the /v1 token guard', () => {
  afterEach(() => vi.restoreAllMocks())

  // /v1's guard is its own instance, derived from its own document, and it is still the per-request
  // ABS check the shared-token model requires — the /v2 mount must not have replaced it.
  it('proves the caller’s token against Audiobookshelf before acting', async () => {
    const pause = vi.fn()
    const validateToken = vi.fn().mockRejectedValue(new AbsAuthError())
    const app = await appWith({ validateToken }, { pause })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause', headers: AUTH })

    expect(res.statusCode).toBe(401)
    expect(validateToken).toHaveBeenCalledWith('user-token')
    expect(pause).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a missing bearer before any handler runs', async () => {
    const pause = vi.fn()
    const app = await appWith({}, { pause })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause' })

    expect(res.statusCode).toBe(401)
    expect(pause).not.toHaveBeenCalled()
    await app.close()
  })

  it('leaves GET /v1/speakers unauthenticated, as contract 1.4.0 decided', async () => {
    const listSpeakers = vi.fn().mockResolvedValue([])
    const app = await buildApp(testConfig(), {
      absClient: { validateToken: vi.fn() } as unknown as AbsClient,
      sonosClient: { listSpeakers } as unknown as SonosClient,
    })
    const res = await app.inject({ method: 'GET', url: '/v1/speakers' })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// Two majors in one process, each mounted from its own contract: an operation belongs to the surface
// that declares it, and to no other. Both directions matter — /v1 must not grow the 2.0.0 auth
// endpoints, and /v2 must not keep serving the machinery it dropped.
describe('the boundary between the served majors', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['POST', '/v1/auth/logout'],
    ['POST', '/v2/auth/refresh'],
  ])('answers %s %s with a contract-shaped 404', async (method, url) => {
    const app = await appWith({ login: vi.fn(), refresh: vi.fn() })
    const res = await app.inject({ method: method as 'POST', url, headers: AUTH, payload: {} })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    await app.close()
  })

  // The /v2 login is declared but unimplemented (#134), so it 404s — but through glue's stub, without
  // reaching Audiobookshelf. The /v1 proxy right next to it must not be what answers it.
  it('does not let the /v1 login proxy answer for the /v2 one', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ login })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: { username: 'lars', password: 's3cret' } })

    expect(res.statusCode).toBe(404)
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })

  it('serves /health on both majors', async () => {
    const app = await buildApp(testConfig(), {
      absClient: { probe: vi.fn().mockResolvedValue('ok') } as unknown as AbsClient,
      // Injected so the check never triggers real SSDP discovery (see health.test.ts).
      sonosClient: { isReachable: vi.fn().mockResolvedValue(true) } as unknown as SonosClient,
    })
    const v1 = await app.inject({ method: 'GET', url: '/v1/health' })
    const v2 = await app.inject({ method: 'GET', url: '/v2/health' })

    expect(v1.json().status).toBe('ok')
    expect(v2.json().status).toBe('ok')
    await app.close()
  })

  it('answers an unknown path under either major with the contract Error shape', async () => {
    const app = await appWith()
    for (const url of ['/v1/nope', '/v2/nope', '/nope']) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    }
    await app.close()
  })
})
