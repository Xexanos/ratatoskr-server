import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import type { ListeningToken, SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { ABS_CHAIN, buildTestApp, DEVICE_TOKEN, V2_AUTH } from './helpers/testApp.js'

// Where the one served major (/v2) is pinned at its mount boundary (SPEC section 6): what the mount
// serves and does not serve, that what 2.0.0 dropped is gone, and that a URL handed out under the mount
// points into it. /v1 answers 410 for everything (v1Sunset.test.ts).

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
}

// SessionManager.start is handed *where* to read its listening token, not the token itself
// (sessionManager.ts), so this unwraps that: the supplier the last start was given.
function listeningOf(start: Mock): ListeningToken {
  return (start.mock.lastCall as [ListeningToken])[0]
}

function appWith(abs: Partial<AbsClient> = {}, sessions: Partial<SessionManager> = {}) {
  return buildTestApp({
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sonosClient: { isReachable: vi.fn().mockResolvedValue(true) } as unknown as SonosClient,
    sessionManager: sessions as SessionManager,
  })
}

describe('the /v2 major is served', () => {
  afterEach(() => vi.restoreAllMocks())

  it('answers /health on the mount', async () => {
    const { app } = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    const res = await app.inject({ method: 'GET', url: '/v2/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
    await app.close()
  })

  it('serves nothing at the unprefixed path', async () => {
    const { app } = await appWith({ probe: vi.fn().mockResolvedValue('ok') })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

// /v2's login must not put an Audiobookshelf pair on the device, the property ADR-0001 exists to
// remove.
describe('the /v2 auth surface', () => {
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

  it('has no refresh route on /v2 and does not reach ABS for one', async () => {
    const refresh = vi.fn().mockResolvedValue(TOKENS)
    const { app } = await appWith({ refresh } as unknown as Partial<AbsClient>)
    const res = await app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: { refreshToken: 'r' } })
    expect(res.statusCode).toBe(404)
    expect(refresh).not.toHaveBeenCalled()
    await app.close()
  })

  it('signs out on /v2/auth/logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })

    const res = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })
    expect(res.statusCode).toBe(204)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    expect(logout).toHaveBeenCalledWith(ABS_CHAIN)
    await app.close()
  })
})

describe('a cover URL carries the /v2 prefix', () => {
  afterEach(() => vi.restoreAllMocks())

  it('mints cover URLs under /v2', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [BOOK], nextCursor: null })
    const { app } = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0].coverUrl).toBe('/v2/library/items/li_1/cover')
    await app.close()
  })
})

// The rotation handover was 1.4.0's protocol and 2.0.0 dropped every part of it (SPEC section 8).
describe('sessions on /v2 carry no rotation handover', () => {
  afterEach(() => vi.restoreAllMocks())

  // The listening token is the session's chain, not the caller's bearer, which is what keeps the sync
  // loop writing progress as the signed-in ABS user.
  it('starts a session on the device chain and ignores a refresh token in the body', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const { app } = await appWith({}, { start })
    await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      headers: V2_AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'r' },
    })
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), 'li_1', 'RINCON_1')
    await expect(listeningOf(start)()).resolves.toBe(ABS_CHAIN.accessToken)
    await app.close()
  })

  // A /v2 session reads the store entry again on every use, so a chain the keep-alive loop renews
  // mid-playback reaches a session that is already running, instead of that session writing progress
  // with a token that expired hours ago (SPEC section 8).
  it('lets a session pick up a chain renewed under it', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const { app, store } = await appWith({}, { start })
    await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      headers: V2_AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })
    const listening = listeningOf(start)

    // What the keep-alive loop's daily sweep does to a chain while its device is listening.
    const renewed = { accessToken: 'abs-chain-access-2', refreshToken: 'abs-chain-refresh-2' }
    await store.updateChain(store.find(DEVICE_TOKEN)!, renewed)

    await expect(listening()).resolves.toBe(renewed.accessToken)
    await app.close()
  })

  it('answers a stopping client with 204', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const { app } = await appWith({}, { stop })
    const res = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: V2_AUTH })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    await app.close()
  })

  it('never puts a rotated pair on a session response', async () => {
    const current = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, rotatedTokens: { accessToken: 'x', refreshToken: 'y' } })
    const { app } = await appWith({}, { current })
    const res = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: V2_AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('rotatedTokens')
    await app.close()
  })
})

describe('what reaches Audiobookshelf', () => {
  afterEach(() => vi.restoreAllMocks())

  // The single most important assertion on this surface: the caller's Ratatoskr token is not a
  // credential Audiobookshelf has ever seen, and it must not be presented as one. What goes upstream
  // is the chain the store holds for that device (SPEC section 8).
  it('sends the device session chain, never the caller bearer', async () => {
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

  // An Audiobookshelf access token must be worthless as a bearer, otherwise the surface that removes
  // upstream credentials from devices would still accept one.
  it('rejects an ABS access token as a bearer', async () => {
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
