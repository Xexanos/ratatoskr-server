import type { SonosDevice, SonosManager } from '@svrooij/sonos'
import { describe, expect, it, vi } from 'vitest'
import { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'

// A minimal SonosDevice stand-in: only the getters toSpeakers reads. A standalone device is
// its own Coordinator; a group member's Coordinator points at the coordinator device.
function device(uuid: string, name: string, coordinator?: SonosDevice): SonosDevice {
  const fake = { Uuid: uuid, Name: name } as unknown as { Uuid: string; Name: string; Coordinator: SonosDevice }
  fake.Coordinator = coordinator ?? (fake as unknown as SonosDevice)
  return fake as unknown as SonosDevice
}

interface FakeManager {
  Devices: SonosDevice[]
  InitializeWithDiscovery: ReturnType<typeof vi.fn>
  InitializeFromDevice: ReturnType<typeof vi.fn>
  CancelSubscription: ReturnType<typeof vi.fn>
}

function fakeManager(
  devices: SonosDevice[],
  opts: { initResult?: boolean; initThrows?: boolean } = {},
): FakeManager {
  const init = vi.fn(async () => {
    if (opts.initThrows) throw new Error('discovery boom')
    return opts.initResult ?? true
  })
  return {
    Devices: devices,
    InitializeWithDiscovery: init,
    InitializeFromDevice: init,
    CancelSubscription: vi.fn(),
  }
}

function clientWith(manager: FakeManager, seedHost?: string): SonosClient {
  return new SonosClient(seedHost, () => manager as unknown as SonosManager)
}

describe('SonosClient', () => {
  describe('listSpeakers projection', () => {
    it('projects a standalone speaker and a multi-member group, sorted by name', async () => {
      const office = device('rincon_office', 'Office')
      const living = device('rincon_living', 'Living Room') // coordinator of the group
      const kitchen = device('rincon_kitchen', 'Kitchen', living)
      const speakers = await clientWith(fakeManager([kitchen, living, office])).listSpeakers()

      expect(speakers).toEqual([
        { id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] },
        { id: 'rincon_office', name: 'Office', isGroup: false },
      ])
    })

    it('omits members for a standalone speaker', async () => {
      const [speaker] = await clientWith(fakeManager([device('rincon_solo', 'Solo')])).listSpeakers()
      expect(speaker).toEqual({ id: 'rincon_solo', name: 'Solo', isGroup: false })
      expect(speaker).not.toHaveProperty('members')
    })
  })

  describe('initialization', () => {
    it('uses SSDP discovery when no seed host is configured', async () => {
      const manager = fakeManager([device('r1', 'A')])
      await clientWith(manager).listSpeakers()
      expect(manager.InitializeWithDiscovery).toHaveBeenCalledOnce()
    })

    it('uses the seed host when configured', async () => {
      const manager = fakeManager([device('r1', 'A')])
      await clientWith(manager, '192.168.1.5').listSpeakers()
      expect(manager.InitializeFromDevice).toHaveBeenCalledWith('192.168.1.5')
    })

    it('maps a discovery exception to SonosUpstreamError', async () => {
      const client = clientWith(fakeManager([], { initThrows: true }))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('maps an unsuccessful init to SonosUpstreamError', async () => {
      const client = clientWith(fakeManager([device('r1', 'A')], { initResult: false }))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('treats zero discovered devices as SonosUpstreamError', async () => {
      const client = clientWith(fakeManager([]))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('initializes only once across calls and reuses the manager', async () => {
      const manager = fakeManager([device('r1', 'A')])
      const factory = vi.fn(() => manager as unknown as SonosManager)
      const client = new SonosClient(undefined, factory)
      await client.listSpeakers()
      await client.listSpeakers()
      expect(factory).toHaveBeenCalledOnce()
      expect(manager.InitializeWithDiscovery).toHaveBeenCalledOnce()
    })

    it('retries initialization after a failure', async () => {
      const bad = fakeManager([], { initThrows: true })
      const good = fakeManager([device('r1', 'A')])
      let call = 0
      const factory = vi.fn(() => (call++ === 0 ? bad : good) as unknown as SonosManager)
      const client = new SonosClient(undefined, factory)

      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
      expect(await client.listSpeakers()).toHaveLength(1)
      expect(factory).toHaveBeenCalledTimes(2)
    })
  })

  describe('isReachable', () => {
    it('returns false before discovery has run, then true once the manager is up', async () => {
      const client = clientWith(fakeManager([device('r1', 'A')]))
      expect(await client.isReachable()).toBe(false) // not yet initialized
      await client.listSpeakers() // initializes and caches
      expect(await client.isReachable()).toBe(true)
    })

    it('returns false when the cached manager has lost all devices', async () => {
      const devices = [device('r1', 'A')]
      const manager = fakeManager(devices)
      const client = clientWith(manager)
      await client.listSpeakers()
      devices.length = 0 // all speakers dropped off the network
      expect(await client.isReachable()).toBe(false)
    })
  })

  describe('close', () => {
    it('cancels the manager subscription', async () => {
      const manager = fakeManager([device('r1', 'A')])
      const client = clientWith(manager)
      await client.listSpeakers()
      await client.close()
      expect(manager.CancelSubscription).toHaveBeenCalledOnce()
    })

    it('is a no-op when the manager was never initialized', async () => {
      await expect(clientWith(fakeManager([])).close()).resolves.toBeUndefined()
    })
  })
})
