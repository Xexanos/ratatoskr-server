import { afterEach, describe, expect, it, vi } from 'vitest'
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

// A Sonos fake is always injected so /health never triggers real SSDP discovery.
function appWith(sonos: Partial<SonosClient>) {
  return buildApp(testConfig(), { sonosClient: sonos as SonosClient })
}

// The ABS reachability check probes GET /ping and expects {"success":true}.
function pingResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('GET /v1/health', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports ok when both Audiobookshelf and Sonos are reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pingResponse({ success: true })))
    const app = await appWith({ isReachable: vi.fn().mockResolvedValue(true) })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.abs).toEqual({ reachable: true })
    expect(body.sonos).toEqual({ reachable: true })
    // SPEC section 14: /health must not leak the server version to unauthenticated callers.
    expect(body.version).toBeUndefined()

    await app.close()
  })

  it('reports degraded with a probing detail before the first Sonos check settles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pingResponse({ success: true })))
    // isReachable() resolves undefined until the first background probe has settled.
    const app = await appWith({ isReachable: vi.fn().mockResolvedValue(undefined) })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.sonos).toEqual({ reachable: false, detail: 'probing, retry shortly' })

    await app.close()
  })

  it('reports degraded when Sonos is unreachable even though Audiobookshelf is up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pingResponse({ success: true })))
    const app = await appWith({ isReachable: vi.fn().mockResolvedValue(false) })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.abs.reachable).toBe(true)
    expect(body.sonos.reachable).toBe(false)

    await app.close()
  })

  it('reports degraded and abs.reachable=false when Audiobookshelf is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))
    const app = await appWith({ isReachable: vi.fn().mockResolvedValue(true) })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.abs.reachable).toBe(false)
    expect(body.sonos.reachable).toBe(true)

    await app.close()
  })

  it('reports abs.reachable=false when the host responds but is not Audiobookshelf', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pingResponse({ nope: true })))
    const app = await appWith({ isReachable: vi.fn().mockResolvedValue(true) })
    const res = await app.inject({ method: 'GET', url: '/v1/health' })

    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.abs).toEqual({ reachable: false, detail: 'host responded but is not Audiobookshelf' })

    await app.close()
  })
})
