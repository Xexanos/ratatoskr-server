import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, ItemNotPlayableError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'
import { NoActiveSessionError } from '../src/playback/errors.js'
import type { SessionManager } from '../src/playback/sessionManager.js'
import type { SonosClient } from '../src/sonos/client.js'

function testConfig(): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerUser: 'streamer',
    absStreamerPassword: 'secret',
    sonosSeedHost: undefined,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    tls: undefined,
    validateResponses: true,
  } as Config
}

const AUTH = { authorization: 'Bearer user-token' }
const SESSION = {
  itemId: 'li_1',
  speakerId: 'RINCON_1',
  state: 'playing',
  positionSeconds: 150,
  durationSeconds: 300,
  updatedAt: '2026-07-11T00:00:00.000Z',
}

// A valid-by-default token validator; override `abs` to simulate an invalid token.
function appWith(sessions: Partial<SessionManager>, abs: Partial<AbsClient> = {}) {
  return buildApp(testConfig(), {
    sessionManager: sessions as SessionManager,
    absClient: { validateToken: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
    sonosClient: {} as SonosClient,
  })
}

describe('PUT /v1/sessions/current', () => {
  afterEach(() => vi.restoreAllMocks())

  it('starts a session and returns it, forwarding the token and body', async () => {
    const start = vi.fn().mockResolvedValue(SESSION)
    const app = await appWith({ start })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/sessions/current',
      headers: AUTH,
      payload: { itemId: 'li_1', speakerId: 'RINCON_1', refreshToken: 'refresh-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SESSION)
    expect(start).toHaveBeenCalledWith('user-token', 'refresh-1', 'li_1', 'RINCON_1')
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
    const app = await appWith({ current: vi.fn().mockResolvedValue(SESSION) })
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
    const pause = vi.fn().mockResolvedValue({ ...SESSION, state: 'paused' })
    const app = await appWith({ pause })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('paused')
    expect(pause).toHaveBeenCalled()
    await app.close()
  })

  it('resumes and returns the session', async () => {
    const resume = vi.fn().mockResolvedValue(SESSION)
    const app = await appWith({ resume })
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/resume', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('playing')
    await app.close()
  })

  it('seeks to the requested position and returns the session', async () => {
    const seek = vi.fn().mockResolvedValue({ ...SESSION, positionSeconds: 42 })
    const app = await appWith({ seek })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/current/seek',
      headers: AUTH,
      payload: { positionSeconds: 42 },
    })
    expect(res.statusCode).toBe(200)
    expect(seek).toHaveBeenCalledWith(42)
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
