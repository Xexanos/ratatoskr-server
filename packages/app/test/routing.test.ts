import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'
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
  }
}

// The clients are never touched: unimplemented/unknown routes fail before any handler logic.
function buildTestApp() {
  return buildApp(testConfig(), { absClient: {} as AbsClient, sonosClient: {} as SonosClient })
}

const AUTH = { authorization: 'Bearer user-token' }

describe('routing fallbacks', () => {
  afterEach(() => vi.restoreAllMocks())

  it('maps an unimplemented session operation to 404 not_found (contract shape)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    await app.close()
  })

  it('still enforces the bearer token on an unimplemented operation (401 without it)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    await app.close()
  })

  it('returns a contract-shaped 404 not_found for an unknown path', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    await app.close()
  })
})
