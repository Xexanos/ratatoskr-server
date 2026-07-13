import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'
import type { SonosClient } from '../src/sonos/client.js'

function testConfig(): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerApiKey: 'streamer-key',
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

// The clients are never touched: the bearer preHandler and the not-found handler both run before
// any ApiService method. (Every contract operation is implemented as of the playback slices, so the
// NotImplementedError fallback is now unreachable via the contract; it is covered as a unit in
// errorHandler.test.ts.)
function buildTestApp() {
  return buildApp(testConfig(), { absClient: {} as AbsClient, sonosClient: {} as SonosClient })
}

const AUTH = { authorization: 'Bearer user-token' }

describe('routing fallbacks', () => {
  afterEach(() => vi.restoreAllMocks())

  it('enforces the bearer token on a session operation (401 without it, before any handler)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/current/pause' })
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
