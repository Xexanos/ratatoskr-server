import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'
import type { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'

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
  }
}

const AUTH = { authorization: 'Bearer user-token' }
const SPEAKERS = [
  { id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] },
  { id: 'rincon_office', name: 'Office', isGroup: false },
]

function appWith(sonos: Partial<SonosClient>) {
  return buildApp(testConfig(), { sonosClient: sonos as SonosClient })
}

describe('GET /v1/speakers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the projected speakers for an authorized request', async () => {
    const listSpeakers = vi.fn().mockResolvedValue(SPEAKERS)
    const app = await appWith({ listSpeakers })
    const res = await app.inject({ method: 'GET', url: '/v1/speakers', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SPEAKERS)
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const listSpeakers = vi.fn()
    const app = await appWith({ listSpeakers })
    const res = await app.inject({ method: 'GET', url: '/v1/speakers' })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(listSpeakers).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps a Sonos failure to 502', async () => {
    const app = await appWith({ listSpeakers: vi.fn().mockRejectedValue(new SonosUpstreamError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/speakers', headers: AUTH })

    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('upstream_error')
    await app.close()
  })
})
