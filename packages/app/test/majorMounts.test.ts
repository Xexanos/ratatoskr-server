import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import type { ListeningToken, SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { ABS_CHAIN, buildTestApp, DEVICE_TOKEN, V2_AUTH } from './helpers/testApp.js'

// Where the two served majors are pinned *against each other* (SPEC section 6). The per-major route
// behavior is covered by the route tests, which all speak /v1; what only shows up with both mounts
// registered is the boundary — that an operationId two documents share does not get one major's
// handler on the other's surface, that what 2.0.0 dropped is gone from /v2 and still there on /v1,
// and that a URL handed out under one mount never points into the other.

const AUTH = { authorization: 'Bearer user-token' }
// Distinctive values, not 'a'/'r': the /v2 login assertions below check that neither string appears
// anywhere in the response body, which a one-character token would satisfy by accident.
const TOKENS = { accessToken: 'abs-access-token', refreshToken: 'abs-refresh-token', user: { id: '42', username: 'lars' } }
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

// SessionManager.start is handed *where* to read its listening token, not the token itself
// (sessionManager.ts), so these two unwrap that: the supplier the last start was given, and what it
// answers right now.
function listeningOf(start: Mock): ListeningToken {
  return (start.mock.lastCall as [ListeningToken])[0]
}

function startedOn(start: Mock): Promise<string> {
  return listeningOf(start)()
}

function appWith(abs: Partial<AbsClient> = {}, sessions: Partial<SessionManager> = {}) {
  return buildTestApp({
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sonosClient: { isReachable: vi.fn().mockResolvedValue(true) } as unknown as SonosClient,
    sessionManager: sessions as SessionManager,
  })
}

describe('both majors are served from one process', () => {
  afterEach(() => vi.restoreAllMocks())

  it('answers /health on each mount', async () => {
    const { app } = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    for (const prefix of ['/v1', '/v2']) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/health` })
      expect(res.statusCode, prefix).toBe(200)
      expect(res.json().status, prefix).toBe('ok')
    }
    await app.close()
  })

  it('serves neither major at the unprefixed path', async () => {
    const { app } = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

// Both documents declare `login` at POST /auth/login and mean incompatible things by it, so the risk
// this block exists for is one major's handler answering on the other's mount: /v1's proxy on /v2
// would put an Audiobookshelf pair on the device, the property ADR-0001 exists to remove, and /v2's
// would hand a frozen client a token it cannot use.
describe('the /v2 auth surface is not the /v1 one', () => {
  afterEach(() => vi.restoreAllMocks())

  it('mints an opaque Ratatoskr token on /v2/auth/login and no ABS token', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const { app } = await appWith({ login })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(login).toHaveBeenCalledWith('lars', 'secret')
    // The identity is upstream's; the credential is not, and neither ABS token appears anywhere.
    expect(res.json().user).toEqual(TOKENS.user)
    expect(res.json().token).not.toBe(TOKENS.accessToken)
    expect(res.body).not.toContain(TOKENS.accessToken)
    expect(res.body).not.toContain(TOKENS.refreshToken)
    expect(res.json()).not.toHaveProperty('accessToken')
    expect(res.json()).not.toHaveProperty('refreshToken')
    await app.close()
  })

  it('still proxies on /v1/auth/login — the frozen major is untouched by the second mount', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const { app } = await appWith({ login })
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
    const { app } = await appWith({ refresh })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: { refreshToken: 'r' } })
    expect(res.statusCode).toBe(404)
    expect(refresh).not.toHaveBeenCalled()
    await app.close()
  })

  // /v1 does not declare the route at all, so its 404 is the not-found handler's — worth pinning
  // next to /v2's 204 so neither mount starts answering for the other's reason.
  it('signs out on /v2/auth/logout, while /v1 has no such route', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })

    const v2 = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })
    expect(v2.statusCode).toBe(204)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    expect(logout).toHaveBeenCalledWith(ABS_CHAIN)

    const v1 = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: V2_AUTH })
    expect(v1.statusCode).toBe(404)
    await app.close()
  })
})

describe('a cover URL carries the prefix of the mount that produced it', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['/v1', '/v1/library/items/li_1/cover', AUTH],
    ['/v2', '/v2/library/items/li_1/cover', V2_AUTH],
  ])('mints %s cover URLs under %s', async (prefix, expected, headers) => {
    const listItems = vi.fn().mockResolvedValue({ books: [BOOK], nextCursor: null })
    const { app } = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: `${prefix}/library/items`, headers })
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
    const { app } = await appWith({}, { start })
    const payload = { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'r' }

    await app.inject({ method: 'PUT', url: '/v1/sessions/current', headers: AUTH, payload })
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), 'r', 'li_1', 'RINCON_1')
    await expect(startedOn(start)).resolves.toBe('user-token')

    // Same body, and /v2 drops the refresh token — it has no handover to arm. The listening token is
    // the session's chain, not the caller's bearer, which is what keeps the sync loop writing
    // progress as the signed-in ABS user.
    await app.inject({ method: 'PUT', url: '/v2/sessions/current', headers: V2_AUTH, payload })
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), undefined, 'li_1', 'RINCON_1')
    await expect(startedOn(start)).resolves.toBe(ABS_CHAIN.accessToken)
    await app.close()
  })

  // The longevity half of the same difference (SPEC section 8): /v1's session holds the pair it was
  // handed and rotates it itself, while /v2's reads the store entry again on every use — so a chain
  // the keep-alive loop renews mid-playback reaches a session that is already running, instead of
  // that session writing progress with a token that expired hours ago.
  it('lets a /v2 session pick up a chain renewed under it, and pins /v1 to the one it was given', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const { app, store } = await appWith({}, { start })
    const payload = { itemId: 'li_1', speakerId: 'RINCON_1' }

    await app.inject({ method: 'PUT', url: '/v1/sessions/current', headers: AUTH, payload })
    const v1Listening = listeningOf(start)
    await app.inject({ method: 'PUT', url: '/v2/sessions/current', headers: V2_AUTH, payload })
    const v2Listening = listeningOf(start)

    // What the keep-alive loop's daily sweep does to a chain while its device is listening.
    const renewed = { accessToken: 'abs-chain-access-2', refreshToken: 'abs-chain-refresh-2' }
    await store.updateChain(store.find(DEVICE_TOKEN)!, renewed)

    await expect(v2Listening()).resolves.toBe(renewed.accessToken)
    await expect(v1Listening()).resolves.toBe('user-token')
    await app.close()
  })

  it('hands a pending pair to a stopping /v1 client, and answers /v2 with 204', async () => {
    const stop = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, state: 'stopped', rotatedTokens: ROTATED })
    const { app } = await appWith({}, { stop })

    const v1 = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(v1.statusCode).toBe(200)
    expect(v1.json().rotatedTokens).toEqual(ROTATED)

    const v2 = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: V2_AUTH })
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
    const { app } = await appWith({}, { current })

    const v1 = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(v1.json().rotatedTokens).toEqual(ROTATED)

    const v2 = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: V2_AUTH })
    expect(v2.statusCode).toBe(200)
    expect(v2.json()).not.toHaveProperty('rotatedTokens')
    await app.close()
  })
})

// The shared service methods forward whatever absToken the request carries, so the two majors differ
// only in what put it there (app.ts). Both halves are pinned here because a regression in either is
// invisible from one surface alone: /v1 must keep sending the caller's own bearer upstream, and /v2
// must never do so.
describe('what reaches Audiobookshelf differs per major', () => {
  afterEach(() => vi.restoreAllMocks())

  it('/v1 passes the request bearer to ABS unchanged', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })
    const { app } = await appWith({ listItems })
    await app.inject({ method: 'GET', url: '/v1/library/items', headers: { authorization: 'Bearer abs-access' } })
    expect(listItems).toHaveBeenCalledWith('abs-access', { searchQuery: undefined, limit: 50, cursor: undefined })
    await app.close()
  })

  // The single most important assertion on this surface: the caller's Ratatoskr token is not a
  // credential Audiobookshelf has ever seen, and it must not be presented as one. What goes upstream
  // is the chain the store holds for that device (SPEC section 8).
  it('/v2 sends the device session chain, never the caller bearer', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })
    const { app } = await appWith({ listItems })
    await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })
    expect(listItems).toHaveBeenCalledWith(ABS_CHAIN.accessToken, {
      searchQuery: undefined,
      limit: 50,
      cursor: undefined,
    })
    expect(listItems).not.toHaveBeenCalledWith(DEVICE_TOKEN, expect.anything())
    await app.close()
  })

  // An Audiobookshelf access token is a perfectly good /v1 bearer and must be worthless on /v2 —
  // otherwise the surface that removes upstream credentials from devices would still accept one.
  it('/v2 rejects an ABS access token as a bearer', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })
    const { app } = await appWith({ listItems })
    const res = await app.inject({
      method: 'GET',
      url: '/v2/library/items',
      headers: { authorization: `Bearer ${ABS_CHAIN.accessToken}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(listItems).not.toHaveBeenCalled()
    await app.close()
  })
})
