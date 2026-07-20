import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'
import { testConfig } from './helpers/testConfig.js'

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

  // Deliberately unauthenticated (contract 1.4.0, SPEC section 8): any LAN device can already
  // enumerate the Sonos topology via SSDP/UPnP, so gating the list adds nothing.
  it('serves the speakers without any bearer token', async () => {
    const listSpeakers = vi.fn().mockResolvedValue(SPEAKERS)
    const app = await appWith({ listSpeakers })
    const res = await app.inject({ method: 'GET', url: '/v1/speakers' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SPEAKERS)
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
