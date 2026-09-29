import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemNotPlayableError } from '../src/abs/errors.js'
import { NoActiveSessionError } from '../src/playback/errors.js'
import type { SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { ABS_CHAIN, buildTestApp, DEVICE_USER, V2_AUTH } from './helpers/testApp.js'

const AUTH = V2_AUTH
// A bearer this server never issued: the guard rejects it before any handler runs.
const UNKNOWN_AUTH = { authorization: 'Bearer never-issued' }
// The playing book as the manager holds it (domain) and as it must appear on the wire (contract).
// Session.item goes through the same mapping step as the library endpoints, so the cover URL is
// minted per response under the serving mount rather than frozen into the session at start().
const BOOK = { id: 'li_1', title: 'Alpha', author: undefined, durationSeconds: 300, hasCover: true, progress: undefined }
const SUMMARY = { id: 'li_1', title: 'Alpha', durationSeconds: 300, coverUrl: '/v2/library/items/li_1/cover' }
// DOMAIN_SESSION is what the SessionManager returns; SESSION is the body the route must produce.
const DOMAIN_SESSION = {
  itemId: 'li_1',
  item: BOOK,
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
}
const SESSION = {
  itemId: 'li_1',
  item: SUMMARY,
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
}

async function appWith(sessions: Partial<SessionManager>) {
  const { app } = await buildTestApp({ sessionManager: sessions as SessionManager, sonosClient: {} as SonosClient })
  return app
}

describe('PUT /v2/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('starts a session and returns it, forwarding the token and body', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const app = await appWith({ start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SESSION)
    // The listening token reaches the manager as a supplier, not a value (sessionManager.ts), and it
    // yields the device's Audiobookshelf access token, never the caller's own Ratatoskr bearer.
    expect(start).toHaveBeenCalledWith(expect.any(Function), 'li_1', 'RINCON_1')
    await expect((start.mock.calls[0] as [() => Promise<string>])[0]()).resolves.toBe(ABS_CHAIN.accessToken)
    await app.close()
  })

  // The session outlives this request by the length of a book, so the supplier must read the chain
  // afresh each time rather than hold the token the request saw (SPEC section 8): a chain the
  // keep-alive loop renews mid-playback has to reach the running session.
  it('hands the manager a supplier that follows a chain renewed after the session started', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const { app, store } = await buildTestApp({ sessionManager: { start } as unknown as SessionManager, sonosClient: {} as SonosClient })
    await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })
    const supplier = (start.mock.calls[0] as [() => Promise<string>])[0]
    await expect(supplier()).resolves.toBe(ABS_CHAIN.accessToken)

    // A far-future exp keeps the renewed token from being refreshed again on the way through.
    const exp = Math.floor(Date.now() / 1000) + 3600
    const renewed = `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
    await store.updateChain({ absUserId: DEVICE_USER.absUserId }, { accessToken: renewed, refreshToken: 'abs-refresh-renewed' })

    await expect(supplier()).resolves.toBe(renewed)
    await app.close()
  })

  it('maps an unplayable item to 400', async () => {
    const start = vi.fn().mockRejectedValue(new ItemNotPlayableError('li_1', 'no audio files'))
    const app = await appWith({ start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('bad_request')
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const app = await appWith({ start: vi.fn() })
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/sessions/current',
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('GET /v2/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the active session', async () => {
    const app = await appWith({ current: vi.fn().mockResolvedValue(DOMAIN_SESSION) })
    const res = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SESSION)
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ current: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })

  it('returns 401 for a bearer this server never issued, without reading the session', async () => {
    const current = vi.fn()
    const app = await appWith({ current })
    const res = await app.inject({ method: 'GET', url: '/v2/sessions/current', headers: UNKNOWN_AUTH })
    expect(res.statusCode).toBe(401)
    expect(current).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('DELETE /v2/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stops the session and returns 204', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const app = await appWith({ stop })
    const res = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(stop).toHaveBeenCalled()
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ stop: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 401 for a bearer this server never issued, without stopping', async () => {
    const stop = vi.fn()
    const app = await appWith({ stop })
    const res = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: UNKNOWN_AUTH })
    expect(res.statusCode).toBe(401)
    expect(stop).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v2/sessions/current/pause | resume | seek', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pauses and returns the session', async () => {
    const pause = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, state: 'paused' })
    const app = await appWith({ pause })
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('paused')
    expect(pause).toHaveBeenCalled()
    await app.close()
  })

  it('resumes and returns the session', async () => {
    const resume = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const app = await appWith({ resume })
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/resume', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('playing')
    await app.close()
  })

  it('seeks to the requested position and returns the session', async () => {
    const seek = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, positionSeconds: 42 })
    const app = await appWith({ seek })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/sessions/current/seek',
      headers: AUTH,
      payload: { positionSeconds: 42 },
    })
    expect(res.statusCode).toBe(200)
    expect(seek).toHaveBeenCalledWith(42)
    await app.close()
  })

  it('rejects a seek without positionSeconds as 400', async () => {
    const app = await appWith({ seek: vi.fn() })
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/seek', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ pause: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 401 for a bearer this server never issued, without touching the session', async () => {
    const pause = vi.fn()
    const app = await appWith({ pause })
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/pause', headers: UNKNOWN_AUTH })
    expect(res.statusCode).toBe(401)
    expect(pause).not.toHaveBeenCalled()
    await app.close()
  })
})
