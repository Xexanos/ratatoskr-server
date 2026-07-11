import type { SonosManager } from '@svrooij/sonos'
import { describe, expect, it, vi } from 'vitest'
import { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'

// Minimal stand-ins for the parsed zone-group topology (only the fields toSpeakers reads).
const member = (uuid: string, name: string, invisible = false) => ({ uuid, name, Invisible: invisible })
const group = (
  coordinator: { uuid: string; name: string },
  members: { uuid: string; name: string; Invisible: boolean }[],
) => ({ groupId: `g_${coordinator.uuid}`, name: coordinator.name, coordinator, members })

type FakeGroup = ReturnType<typeof group>

interface FakeOpts {
  noDevices?: boolean
  initResult?: boolean
  initThrows?: boolean
  readThrows?: boolean
}

interface FakeManager {
  Devices: { GetZoneGroupState: ReturnType<typeof vi.fn> }[]
  InitializeWithDiscovery: ReturnType<typeof vi.fn>
  InitializeFromDevice: ReturnType<typeof vi.fn>
  CancelSubscription: ReturnType<typeof vi.fn>
}

// A fake manager whose single entry device returns the given zone-group topology from
// GetZoneGroupState (what the live read consumes). `readThrows` makes the live read reject;
// `noDevices`/`initResult`/`initThrows` drive init.
function fakeManager(groups: FakeGroup[] = [], opts: FakeOpts = {}): FakeManager {
  const init = vi.fn(async () => {
    if (opts.initThrows) throw new Error('discovery boom')
    return opts.initResult ?? true
  })
  const entry = {
    GetZoneGroupState: vi.fn(async () => {
      if (opts.readThrows) throw new Error('read boom')
      return groups
    }),
  }
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
      const living = member('rincon_living', 'Living Room')
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

    it('excludes Invisible members (e.g. a Boost/Bridge)', async () => {
      const living = member('rincon_living', 'Living Room')
      const groups = [
        group(living, [living, member('rincon_kitchen', 'Kitchen'), member('rincon_boost', 'BOOST', true)]),
      ]
      const [speaker] = await clientWith(fakeManager(groups)).listSpeakers()
      expect(speaker).toEqual({ id: 'rincon_living', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] })
    })

    it('treats a lone visible speaker beside a hidden device as standalone', async () => {
      const living = member('rincon_living', 'Living Room')
      const groups = [group(living, [living, member('rincon_boost', 'BOOST', true)])]
      const [speaker] = await clientWith(fakeManager(groups)).listSpeakers()
      expect(speaker).toEqual({ id: 'rincon_living', name: 'Living Room', isGroup: false })
    })
  })

  describe('initialization', () => {
    it('uses SSDP discovery when no seed host is configured', async () => {
      const manager = fakeManager(SOLO)
      await clientWith(manager).listSpeakers()
      expect(manager.InitializeWithDiscovery).toHaveBeenCalledOnce()
    })

    it('uses the seed host when configured, defaulting to the Sonos port 1400', async () => {
      const manager = fakeManager(SOLO)
      await clientWith(manager, '192.168.1.5').listSpeakers()
      expect(manager.InitializeFromDevice).toHaveBeenCalledWith('192.168.1.5', 1400)
    })

    it('accepts an explicit host:port seed (for the containerized fake Sonos)', async () => {
      const manager = fakeManager(SOLO)
      await clientWith(manager, '127.0.0.1:54321').listSpeakers()
      expect(manager.InitializeFromDevice).toHaveBeenCalledWith('127.0.0.1', 54321)
    })

    it('maps a discovery exception to SonosUpstreamError', async () => {
      await expect(clientWith(fakeManager([], { initThrows: true })).listSpeakers()).rejects.toBeInstanceOf(
        SonosUpstreamError,
      )
    })

    it('maps an unsuccessful init to SonosUpstreamError', async () => {
      await expect(clientWith(fakeManager(SOLO, { initResult: false })).listSpeakers()).rejects.toBeInstanceOf(
        SonosUpstreamError,
      )
    })

    it('treats zero discovered devices as SonosUpstreamError', async () => {
      await expect(clientWith(fakeManager([], { noDevices: true })).listSpeakers()).rejects.toBeInstanceOf(
        SonosUpstreamError,
      )
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

  describe('live topology read', () => {
    it('maps a failing GetZoneGroupState to SonosUpstreamError and re-discovers next time', async () => {
      const bad = fakeManager(SOLO, { readThrows: true })
      const good = fakeManager(SOLO)
      let call = 0
      const factory = vi.fn(() => (call++ === 0 ? bad : good) as unknown as SonosManager)
      const client = new SonosClient(undefined, factory)

      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
      // the failed read dropped the manager, so the next call re-initializes
      expect(await client.listSpeakers()).toHaveLength(1)
      expect(factory).toHaveBeenCalledTimes(2)
    })
  })

  describe('isReachable', () => {
    it('is false before any read, then true after a successful read', async () => {
      const client = clientWith(fakeManager(SOLO))
      expect(await client.isReachable()).toBe(false) // no live read has completed yet
      await client.listSpeakers()
      expect(await client.isReachable()).toBe(true)
    })

    it('flips back to false after a failed live read', async () => {
      const manager = fakeManager(SOLO, { readThrows: true })
      const client = clientWith(manager)
      await expect(client.listSpeakers()).rejects.toBeInstanceOf(SonosUpstreamError)
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

    it('cancels (not caches) a manager whose init finishes after close', async () => {
      let resolveInit: (ok: boolean) => void = () => {}
      const initPromise = new Promise<boolean>((resolve) => {
        resolveInit = resolve
      })
      const manager: FakeManager = {
        Devices: [{ GetZoneGroupState: vi.fn(async () => SOLO) }],
        InitializeWithDiscovery: vi.fn(() => initPromise),
        InitializeFromDevice: vi.fn(() => initPromise),
        CancelSubscription: vi.fn(),
      }
      const client = clientWith(manager)

      const pending = client.listSpeakers() // suspends awaiting init
      await client.close() // closed before init resolves
      resolveInit(true) // init now completes

      await expect(pending).rejects.toBeInstanceOf(SonosUpstreamError)
      expect(manager.CancelSubscription).toHaveBeenCalled()
    })
  })
})
