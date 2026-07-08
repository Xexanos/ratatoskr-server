import type { components } from '@ratatoskr/contract'
import { SonosManager } from '@svrooij/sonos'
import type { SonosDevice } from '@svrooij/sonos'
import { SonosUpstreamError } from './errors.js'

type Speaker = components['schemas']['Speaker']

// SonosManager.InitializeWithDiscovery resolves as soon as one device answers SSDP; this
// bound only caps the wait when no speaker responds at all.
const DISCOVERY_TIMEOUT_SECONDS = 5

// Lets tests inject a fake manager; production uses a real node-sonos-ts manager.
export type SonosManagerFactory = () => SonosManager

// Controls Sonos over the LAN via node-sonos-ts (SPEC section 3). For phase 3b this is just
// the discovery/topology slice behind /speakers and /health; playback lands in phase 4. The
// manager is initialized once and kept — it holds a zone-event subscription that keeps the
// topology current, and phase 4 builds transport control on the same instance.
export class SonosClient {
  private manager: SonosManager | undefined
  private initPromise: Promise<SonosManager> | undefined

  constructor(
    private readonly seedHost: string | undefined,
    private readonly createManager: SonosManagerFactory = () => new SonosManager(),
  ) {}

  async listSpeakers(): Promise<Speaker[]> {
    const manager = await this.ensureManager()
    return toSpeakers(manager.Devices)
  }

  // Non-blocking: reports what we already know and kicks off discovery in the background if it
  // has not run yet, so a polled /health never waits on SSDP discovery. Reachability improves
  // to true once the background discovery completes.
  async isReachable(): Promise<boolean> {
    if (this.manager) return this.manager.Devices.length > 0
    void this.ensureManager().catch(() => {})
    return false
  }

  async close(): Promise<void> {
    this.manager?.CancelSubscription()
    this.manager = undefined
    this.initPromise = undefined
  }

  // Initialize the manager exactly once. Concurrent callers share the in-flight promise; a
  // failed init is not cached, so the next call retries.
  private async ensureManager(): Promise<SonosManager> {
    if (this.manager) return this.manager
    if (!this.initPromise) this.initPromise = this.initialize()
    try {
      this.manager = await this.initPromise
      return this.manager
    } catch (err) {
      this.initPromise = undefined
      throw err
    }
  }

  private async initialize(): Promise<SonosManager> {
    const manager = this.createManager()
    let ok: boolean
    try {
      ok = this.seedHost
        ? await manager.InitializeFromDevice(this.seedHost)
        : await manager.InitializeWithDiscovery(DISCOVERY_TIMEOUT_SECONDS)
    } catch {
      throw new SonosUpstreamError('Sonos discovery failed')
    }
    if (!ok || manager.Devices.length === 0) {
      throw new SonosUpstreamError('No Sonos devices found on the network')
    }
    return manager
  }
}

// Project discovered devices onto the contract's Speaker shape: one Speaker per zone group.
// Devices are grouped by their coordinator (a standalone speaker is its own coordinator, so
// isGroup is false); a multi-member group reports the members' room names.
function toSpeakers(devices: readonly SonosDevice[]): Speaker[] {
  const groups = new Map<string, { coordinator: SonosDevice; members: SonosDevice[] }>()
  for (const device of devices) {
    const coordinator = device.Coordinator ?? device
    const group = groups.get(coordinator.Uuid)
    if (group) {
      group.members.push(device)
    } else {
      groups.set(coordinator.Uuid, { coordinator, members: [device] })
    }
  }

  const speakers: Speaker[] = []
  for (const { coordinator, members } of groups.values()) {
    const isGroup = members.length > 1
    const speaker: Speaker = { id: coordinator.Uuid, name: coordinator.Name, isGroup }
    if (isGroup) {
      speaker.members = members.map((member) => member.Name).sort((a, b) => a.localeCompare(b))
    }
    speakers.push(speaker)
  }
  return speakers.sort((a, b) => a.name.localeCompare(b.name))
}
