import type { SonosManager } from '@svrooij/sonos'
import { describe, expect, it, vi } from 'vitest'
import { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'

// Minimal stand-ins for the parsed zone-group topology (only the fields toSpeakers reads).
const member = (uuid: string, name: string) => ({ uuid, name })
const group = (
  coordinator: { uuid: string; name: string },
  members: { uuid: string; name: string }[],
) => ({ groupId: `g_${coordinator.uuid}`, name: coordinator.name, coordinator, members })

type FakeGroup = ReturnType<typeof group>

interface FakeManager {
  Devices: { GetZoneGroupState: ReturnType<typeof vi.fn> }[]
  InitializeWithDiscovery: ReturnType<typeof vi.fn>
  InitializeFromDevice: ReturnType<typeof vi.fn>
  CancelSubscription: ReturnType<typeof vi.fn>
}

// A fake manager whose single entry device returns the given zone-group topology from
// GetZoneGroupState (what listSpeakers reads live). `noDevices` simulates discovery finding
// nothing; `initResult`/`initThrows` drive the init outcome.
function fakeManager(
  groups: FakeGroup[] = [],
  opts: { noDevices?: boolean; initResult?: boolean; initThrows?: boolean } = {},
): FakeManager {
  const init = vi.fn(async () => {
    if (opts.initThrows) throw new Error('discovery boom')
    return opts.initResult ?? true
  })
  const entry = { GetZoneGroupState: vi.fn(async () => groups) }
  return {
    Devices: opts.noDevices ? [] : [entry],
    InitializeWithDiscovery: init,
    InitializeFromDevice: init,
    CancelSubscription: vi.fn(),
  }
}

function clientWith(manager: FakeManager, seedHost?: string): SonosClient {
  return new SonosClient(seedHost, () => manager as unknown as SonosManager)
}

const SOLO = [group(member('r1', 'A'), [member('r1', 'A')])]

describe('SonosClient', () => {
  describe('listSpeakers projection', () => {
    it('projects a standalone speaker and a multi-member group, sorted by name', async () => {
      const living = member('rincon_living', 'Living Room') // coordinator of the group
      const groups = [
        group(living, [living, member('rincon_kitchen', 'Kitchen')]),
        group(member('rincon_office', 'Office'), [member('rincon_office', 'Office')]),
      ]
      const speakers = await clientWith(fakeManager(groups)).listSpeakers()

      expect(speakers).toEqual([
        { id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] },
        { id: 'rincon_office', name: 'Office', isGroup: false },
      ])
    })

    it('omits members for a standalone speaker', async () => {
      const solo = member('rincon_solo', 'Solo')
      const [speaker] = await clientWith(fakeManager([group(solo, [solo])])).listSpeakers()
      expect(speaker).toEqual({ id: 'rincon_solo', name: 'Solo', isGroup: false })
      expect(speaker).not.toHaveProperty('members')
    })
  })

  describe('initialization', () => {
    it('uses SSDP discovery when no seed host is configured', async () => {
      const manager = fakeManager(SOLO)
      await clientWith(manager).listSpeakers()
      expect(manager.InitializeWithDiscovery).toHaveBeenCalledOnce()
    })

    it('uses the seed host when configured', async () => {
      const manager = fakeManager(SOLO)
      await clientWith(manager, '192.168.1.5').listSpeakers()
      expect(manager.InitializeFromDevice).toHaveBeenCalledWith('192.168.1.5')
    })

    it('maps a discovery exception to SonosUpstreamError', async () => {
      const client = clientWith(fakeManager([], { initThrows: true }))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('maps an unsuccessful init to SonosUpstreamError', async () => {
      const client = clientWith(fakeManager(SOLO, { initResult: false }))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('treats zero discovered devices as SonosUpstreamError', async () => {
      const client = clientWith(fakeManager([], { noDevices: true }))
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
    })

    it('initializes only once across calls and reuses the manager', async () => {
      const manager = fakeManager(SOLO)
      const factory = vi.fn(() => manager as unknown as SonosManager)
      const client = new SonosClient(undefined, factory)
      await client.listSpeakers()
      await client.listSpeakers()
      expect(factory).toHaveBeenCalledOnce()
      expect(manager.InitializeWithDiscovery).toHaveBeenCalledOnce()
    })

    it('retries initialization after a failure', async () => {
      const bad = fakeManager([], { initThrows: true })
      const good = fakeManager(SOLO)
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
      const client = clientWith(fakeManager(SOLO))
      expect(await client.isReachable()).toBe(false) // not yet initialized
      await client.listSpeakers() // initializes and caches
      expect(await client.isReachable()).toBe(true)
    })

    it('returns false when the cached manager has lost all devices', async () => {
      const manager = fakeManager(SOLO)
      const client = clientWith(manager)
      await client.listSpeakers()
      manager.Devices.length = 0 // all speakers dropped off the network
      expect(await client.isReachable()).toBe(false)
    })
  })

  describe('close', () => {
    it('cancels the manager subscription', async () => {
      const manager = fakeManager(SOLO)
      const client = clientWith(manager)
      await client.listSpeakers()
      await client.close()
      expect(manager.CancelSubscription).toHaveBeenCalledOnce()
    })

    it('is a no-op when the manager was never initialized', async () => {
      await expect(clientWith(fakeManager()).close()).resolves.toBeUndefined()
    })
  })
})
