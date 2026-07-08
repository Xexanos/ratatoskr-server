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
// manager is initialized once and kept (phase 4 builds transport control on the same
// instance); listSpeakers reads the topology live each call, so it does not depend on the
// manager's event subscription staying reachable (see listSpeakers).
export class SonosClient {
  private manager: SonosManager | undefined
  private initPromise: Promise<SonosManager> | undefined

  constructor(
    private readonly seedHost: string | undefined,
    private readonly createManager: SonosManagerFactory = () => new SonosManager(),
  ) {}

  async listSpeakers(): Promise<Speaker[]> {
    const manager = await this.ensureManager()
    // Read the live zone topology on each call rather than trusting the manager's cached
    // `.Devices`, which only stays current via a UPnP event subscription — a bridged Docker
    // network can't deliver those speaker->server callbacks, so the cache would go stale.
    // GetZoneGroupState is a plain unicast request and works wherever outbound control does.
    const [entry] = manager.Devices
    if (entry === undefined) throw new SonosUpstreamError('No Sonos devices found on the network')
    return toSpeakers(await entry.GetZoneGroupState())
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

// The parsed zone-group topology as returned by SonosDevice.GetZoneGroupState (derived from
// the method so we don't deep-import the library's internal ZoneGroup type).
type ZoneGroups = Awaited<ReturnType<SonosDevice['GetZoneGroupState']>>

// Project the zone-group topology onto the contract's Speaker shape: one Speaker per group.
// A standalone speaker is a group of one (isGroup false); a multi-member group reports the
// members' room names. The id is the coordinator's UUID (the stable target for playback).
function toSpeakers(groups: ZoneGroups): Speaker[] {
  return groups
    .map((group) => {
      const isGroup = group.members.length > 1
      const speaker: Speaker = { id: group.coordinator.uuid, name: group.coordinator.name, isGroup }
      if (isGroup) {
        speaker.members = group.members.map((member) => member.name).sort((a, b) => a.localeCompare(b))
      }
      return speaker
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
