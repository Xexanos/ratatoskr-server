import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'

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
  }
}

describe('GET /v1/health', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports ok and abs.reachable=true when Audiobookshelf responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    )
    const app = await buildApp(testConfig(), { validateResponses: true })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.abs).toEqual({ reachable: true })
    expect(body.sonos.reachable).toBe(false)
    // SPEC section 14: /health must not leak the server version to unauthenticated callers.
    expect(body.version).toBeUndefined()

    await app.close()
  })

  it('reports degraded and abs.reachable=false when Audiobookshelf is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))
    const app = await buildApp(testConfig(), { validateResponses: true })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.abs.reachable).toBe(false)

    await app.close()
  })
})
