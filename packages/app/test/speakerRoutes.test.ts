import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'
import { buildTestApp, V2_AUTH } from './helpers/testApp.js'

// What SonosClient returns (domain: members explicitly undefined for a lone speaker) and what the
// route must then put on the wire (contract: the field dropped entirely).
const ZONES = [
  { id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] },
  { id: 'rincon_office', name: 'Office', isGroup: false, members: undefined },
]
const SPEAKERS = [
  { id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] },
  { id: 'rincon_office', name: 'Office', isGroup: false },
]

async function appWith(sonos: Partial<SonosClient>) {
  return (await buildTestApp({ sonosClient: sonos as SonosClient })).app
}

describe('GET /v2/speakers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the projected speakers for an authorized request', async () => {
    const listSpeakers = vi.fn().mockResolvedValue(ZONES)
    const app = await appWith({ listSpeakers })
    const res = await app.inject({ method: 'GET', url: '/v2/speakers', headers: V2_AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SPEAKERS)
    await app.close()
  })

  // Deliberately unauthenticated (contract 1.4.0, SPEC section 8): any LAN device can already
  // enumerate the Sonos topology via SSDP/UPnP, so gating the list adds nothing.
  it('serves the speakers without any bearer token', async () => {
    const listSpeakers = vi.fn().mockResolvedValue(ZONES)
    const app = await appWith({ listSpeakers })
    const res = await app.inject({ method: 'GET', url: '/v2/speakers' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SPEAKERS)
    await app.close()
  })

  it('maps a Sonos failure to 502', async () => {
    const app = await appWith({ listSpeakers: vi.fn().mockRejectedValue(new SonosUpstreamError()) })
    const res = await app.inject({ method: 'GET', url: '/v2/speakers', headers: V2_AUTH })

    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('upstream_error')
    await app.close()
  })
})
