import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, ItemNotPlayableError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import { NoActiveSessionError } from '../src/playback/errors.js'
import type { SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'
import { tempSessionStore } from './helpers/tempSessionStore.js'
import { testConfig } from './helpers/testConfig.js'

const AUTH = { authorization: 'Bearer user-token' }
// The playing book as the manager holds it (domain) and as it must appear on the wire (contract).
// Session.item goes through the same mapping step as the library endpoints, so the cover URL is
// minted per response under the serving mount rather than frozen into the session at start().
const BOOK = { id: 'li_1', title: 'Alpha', author: undefined, durationSeconds: 300, hasCover: true, progress: undefined }
const SUMMARY = { id: 'li_1', title: 'Alpha', durationSeconds: 300, coverUrl: '/v1/library/items/li_1/cover' }
// DOMAIN_SESSION is what the SessionManager returns; SESSION is the body the route must produce.
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
const SESSION = {
  itemId: 'li_1',
  item: SUMMARY,
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
}

// A valid-by-default token validator; override `abs` to simulate an invalid token.
async function appWith(sessions: Partial<SessionManager>, abs: Partial<AbsClient> = {}) {
  return buildApp(testConfig(), {
    sessionManager: sessions as SessionManager,
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sonosClient: {} as SonosClient,
    sessionStore: await tempSessionStore(),
  })
}

describe('PUT /v1/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('starts a session and returns it, forwarding the token and body', async () => {
    const start = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const app = await appWith({ start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'refresh-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SESSION)
    // The listening token reaches the manager as a supplier, not a value (sessionManager.ts): on
    // /v1 it is a constant, because the caller's bearer *is* the upstream token and nothing behind
    // this route renews it.
    expect(start).toHaveBeenCalledWith(expect.any(Function), 'refresh-1', 'li_1', 'RINCON_1')
    await expect((start.mock.calls[0] as [() => Promise<string>])[0]()).resolves.toBe('user-token')
    await app.close()
  })

  it('maps an unplayable item to 400', async () => {
    const start = vi.fn().mockRejectedValue(new ItemNotPlayableError('li_1', 'no audio files'))
    const app = await appWith({ start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/current',
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
      url: '/v1/sessions/current',
      payload: { itemId: 'li_1', speakerId: 'RINCON_1' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('GET /v1/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the active session', async () => {
    const app = await appWith({ current: vi.fn().mockResolvedValue(DOMAIN_SESSION) })
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SESSION)
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ current: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })

  it('passes a pending rotated token pair through on the session (contract-valid)', async () => {
    const rotatedTokens = { accessToken: 'new-access', refreshToken: 'new-refresh' }
    const current = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, rotatedTokens })
    const app = await appWith({ current })
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().rotatedTokens).toEqual(rotatedTokens)
    expect(current).toHaveBeenCalledWith('user-token')
    await app.close()
  })

  it('returns 401 for a non-empty but invalid bearer, without reading the session', async () => {
    const current = vi.fn()
    const app = await appWith({ current }, { validateToken: vi.fn().mockRejectedValue(new AbsAuthError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(401)
    expect(current).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('DELETE /v1/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stops the session and returns 204', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const app = await appWith({ stop })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(stop).toHaveBeenCalled()
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ stop: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 200 with the final Session when a rotated token pair was pending at stop', async () => {
    const rotatedTokens = { accessToken: 'new-access', refreshToken: 'new-refresh' }
    const stop = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, state: 'stopped', rotatedTokens })
    const app = await appWith({ stop })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().rotatedTokens).toEqual(rotatedTokens)
    expect(stop).toHaveBeenCalledWith('user-token') // caller token forwarded for adoption
    await app.close()
  })

  it('returns 401 for a non-empty but invalid bearer, without stopping', async () => {
    const stop = vi.fn()
    const app = await appWith({ stop }, { validateToken: vi.fn().mockRejectedValue(new AbsAuthError()) })
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(401)
    expect(stop).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/sessions/current/pause | resume | seek', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pauses and returns the session', async () => {
    const pause = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, state: 'paused' })
    const app = await appWith({ pause })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('paused')
    expect(pause).toHaveBeenCalled()
    await app.close()
  })

  it('resumes and returns the session', async () => {
    const resume = vi.fn().mockResolvedValue(DOMAIN_SESSION)
    const app = await appWith({ resume })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/resume', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('playing')
    await app.close()
  })

  it('seeks to the requested position and returns the session', async () => {
    const seek = vi.fn().mockResolvedValue({ ...DOMAIN_SESSION, positionSeconds: 42 })
    const app = await appWith({ seek })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/current/seek',
      headers: AUTH,
      payload: { positionSeconds: 42 },
    })
    expect(res.statusCode).toBe(200)
    expect(seek).toHaveBeenCalledWith('user-token', 42) // caller token forwarded for adoption
    await app.close()
  })

  it('rejects a seek without positionSeconds as 400', async () => {
    const app = await appWith({ seek: vi.fn() })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/seek', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 404 when nothing is playing', async () => {
    const app = await appWith({ pause: vi.fn().mockRejectedValue(new NoActiveSessionError()) })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 401 for a non-empty but invalid bearer, without touching the session', async () => {
    const pause = vi.fn()
    const app = await appWith({ pause }, { validateToken: vi.fn().mockRejectedValue(new AbsAuthError()) })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(401)
    expect(pause).not.toHaveBeenCalled()
    await app.close()
  })
})
