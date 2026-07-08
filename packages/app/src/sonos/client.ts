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

// Controls Sonos over the LAN via node-sonos-ts (SPEC section 3). Phase 3b is just the
// discovery/topology slice behind /speakers and /health; playback lands in phase 4 on the same
// (kept) manager. Every read hits the live zone topology (GetZoneGroupState, a unicast request)
// rather than the manager's cached `.Devices`, which only stays current via a UPnP event
// subscription a bridged Docker network can't deliver; a failed read drops the manager so the
// next call re-discovers, and reachability tracks the last live read rather than the cache.
export class SonosClient {
  private manager: SonosManager | undefined
  private initPromise: Promise<SonosManager> | undefined
  private reachable = false
  private closed = false
  private refreshing = false

  constructor(
    private readonly seedHost: string | undefined,
    private readonly createManager: SonosManagerFactory = () => new SonosManager(),
  ) {}

  async listSpeakers(): Promise<Speaker[]> {
    return toSpeakers(await this.readTopology())
  }

  // Non-blocking: returns the last live-read outcome and refreshes it in the background, so a
  // frequently polled /health neither waits on SSDP nor trusts a never-shrinking device cache.
  async isReachable(): Promise<boolean> {
    void this.refreshReachability()
    return this.reachable
  }

  async close(): Promise<void> {
    this.closed = true
    this.reset()
  }

  // Read the live zone-group topology. On any failure, drop the manager (so the next call
  // re-discovers) and surface a SonosUpstreamError (-> 502, the only failure /speakers declares).
  private async readTopology(): Promise<ZoneGroups> {
    try {
      const manager = await this.ensureManager()
      const [entry] = manager.Devices
      if (entry === undefined) throw new SonosUpstreamError('No Sonos devices found on the network')
      const groups = await entry.GetZoneGroupState()
      this.reachable = true
      return groups
    } catch (err) {
      this.reset()
      this.reachable = false
      throw err instanceof SonosUpstreamError ? err : new SonosUpstreamError('Sonos did not respond')
    }
  }

  private async refreshReachability(): Promise<void> {
    if (this.refreshing || this.closed) return
    this.refreshing = true
    try {
      await this.readTopology()
    } catch {
      // readTopology already recorded reachable=false; /health just reflects it.
    } finally {
      this.refreshing = false
    }
  }

  // Initialize the manager exactly once. Concurrent callers share the in-flight promise; a failed
  // init is not cached. If the client was closed while init was in flight, cancel the freshly
  // built manager's subscription rather than caching a live one (avoids a leaked renew timer /
  // event listener that keeps the process from exiting).
  private async ensureManager(): Promise<SonosManager> {
    if (this.manager) return this.manager
    if (!this.initPromise) this.initPromise = this.initialize()
    let manager: SonosManager
    try {
      manager = await this.initPromise
    } catch (err) {
      this.initPromise = undefined
      throw err
    }
    if (this.closed) {
      try {
        manager.CancelSubscription()
      } catch {
        // best effort
      }
      throw new SonosUpstreamError('Sonos client is closed')
    }
    this.manager = manager
    return manager
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

  // Drop the manager so the next read re-discovers. Best-effort cancels the (possibly dead)
  // subscription first so node-sonos-ts's renew interval / event listener don't leak.
  private reset(): void {
    try {
      this.manager?.CancelSubscription()
    } catch {
      // best effort — the manager may already be unreachable
    }
    this.manager = undefined
    this.initPromise = undefined
  }
}

// The parsed zone-group topology as returned by SonosDevice.GetZoneGroupState (derived from the
// method so we don't deep-import the library's internal ZoneGroup type).
type ZoneGroups = Awaited<ReturnType<SonosDevice['GetZoneGroupState']>>

// Project the zone-group topology onto the contract's Speaker shape: one Speaker per group.
// Invisible members (e.g. a Boost/Bridge or other hidden device) are excluded so a lone speaker
// is not reported as a group. id/name come from the coordinator; a multi-member group lists the
// visible members' room names.
function toSpeakers(groups: ZoneGroups): Speaker[] {
  return groups
    .map((group) => {
      const visible = group.members.filter((member) => !member.Invisible)
      const isGroup = visible.length > 1
      const speaker: Speaker = { id: group.coordinator.uuid, name: group.coordinator.name, isGroup }
      if (isGroup) {
        speaker.members = visible.map((member) => member.name).sort((a, b) => a.localeCompare(b))
      }
      return speaker
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
