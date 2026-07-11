import type { components } from '@ratatoskr/contract'
import type { PlaybackPlan, SeekPlan } from '@ratatoskr/position'
import { SonosDevice, SonosManager } from '@svrooij/sonos'
import { buildTrackMetadata, escapeXml } from './didl.js'
import { hmsToSeconds, secondsToHms } from './time.js'
import { SonosUpstreamError } from './errors.js'

type Speaker = components['schemas']['Speaker']

// Where the coordinator currently is: which queue track (0-based) and elapsed seconds within it.
// RelTime is authoritative; Sonos's TrackDuration is not (SPEC section 4), so it is not returned.
export interface SonosPosition {
  trackIndex: number
  relTimeSeconds: number
}

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

  // --- Playback control (SPEC sections 4 and 5) ---

  // Replace the coordinator's queue with the book's tracks (each carrying DIDL-Lite metadata so
  // Sonos knows the mime — a bare URL fails with UPnP 714, SPEC §4), point the transport at the
  // queue, and start playing. Does NOT seek — the caller seeks to the resume position after.
  async startPlayback(speakerId: string, plan: PlaybackPlan): Promise<void> {
    const coordinator = await this.coordinatorFor(speakerId)
    const av = coordinator.AVTransportService
    try {
      await av.RemoveAllTracksFromQueue({ InstanceID: 0 })
      for (const [index, track] of plan.tracks.entries()) {
        await av.AddURIToQueue({
          InstanceID: 0,
          EnqueuedURI: track.url,
          // The library inserts string metadata into the SOAP body verbatim, so escape it here.
          EnqueuedURIMetaData: escapeXml(buildTrackMetadata(track)),
          DesiredFirstTrackNumberEnqueued: index + 1,
          EnqueueAsNext: false,
        })
      }
      await av.SetAVTransportURI({
        InstanceID: 0,
        CurrentURI: `x-rincon-queue:${coordinator.Uuid}#0`,
        CurrentURIMetaData: '',
      })
      await av.Play({ InstanceID: 0, Speed: '1' })
    } catch (err) {
      throw asUpstream(err)
    }
  }

  async stop(speakerId: string): Promise<void> {
    const coordinator = await this.coordinatorFor(speakerId)
    try {
      await coordinator.AVTransportService.Stop({ InstanceID: 0 })
    } catch (err) {
      throw asUpstream(err)
    }
  }

  async pause(speakerId: string): Promise<void> {
    const coordinator = await this.coordinatorFor(speakerId)
    try {
      await coordinator.AVTransportService.Pause({ InstanceID: 0 })
    } catch (err) {
      throw asUpstream(err)
    }
  }

  // Resume playback (Play on the existing queue, no transport-URI change).
  async play(speakerId: string): Promise<void> {
    const coordinator = await this.coordinatorFor(speakerId)
    try {
      await coordinator.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
    } catch (err) {
      throw asUpstream(err)
    }
  }

  // Seek to (track, in-track offset) per a SeekPlan. Each attempt re-issues BOTH the track select
  // and the in-track seek, then verifies the coordinator is on the right track AND within the
  // tolerance window. The whole attempt is retried on a thrown Seek too — right after Play or a
  // track change the transport is often TRANSITIONING and rejects a Seek, so a transient failure
  // must not abort resume. Settle/tolerance/retries come from the plan (config knobs).
  //
  // On exhaustion: if we at least reached the right track, accept it (an offset a few seconds off
  // self-corrects on the next poll). If we never reached the track, throw — a resume in the wrong
  // track is hours off and the sync loop would record it as truth, which is worse than a visible
  // failure (SPEC §4/§5).
  async seek(speakerId: string, plan: SeekPlan): Promise<void> {
    const coordinator = await this.coordinatorFor(speakerId)
    const av = coordinator.AVTransportService
    const { settleMs, toleranceSeconds, retries } = plan.tuning
    const targetTrack = plan.trackIndex + 1
    let lastError: unknown
    let reachedTrack = false

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await av.Seek({ InstanceID: 0, Unit: 'TRACK_NR', Target: String(targetTrack) })
        await av.Seek({ InstanceID: 0, Unit: 'REL_TIME', Target: secondsToHms(plan.offsetSeconds) })
        if (settleMs > 0) await delay(settleMs)
        const info = await av.GetPositionInfo({ InstanceID: 0 })
        reachedTrack = (typeof info.Track === 'number' ? info.Track : -1) === targetTrack
        if (reachedTrack && Math.abs(hmsToSeconds(info.RelTime) - plan.offsetSeconds) <= toleranceSeconds) {
          return
        }
        lastError = new SonosUpstreamError(`seek landed off target (track ${info.Track}, rel ${info.RelTime})`)
      } catch (err) {
        lastError = err
        reachedTrack = false
      }
      // Let a TRANSITIONING transport settle before the next attempt.
      if (settleMs > 0 && attempt < retries) await delay(settleMs)
    }

    if (reachedTrack) return
    throw asUpstream(lastError)
  }

  async getPosition(speakerId: string): Promise<SonosPosition> {
    const coordinator = await this.coordinatorFor(speakerId)
    try {
      const info = await coordinator.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      const track = typeof info.Track === 'number' ? info.Track : 1
      return { trackIndex: Math.max(0, track - 1), relTimeSeconds: hmsToSeconds(info.RelTime) }
    } catch (err) {
      throw asUpstream(err)
    }
  }

  // The coordinator's raw transport state (PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING /
  // NO_MEDIA_PRESENT). Must be read from the coordinator — a non-coordinator always reports PLAYING.
  async getTransportState(speakerId: string): Promise<string> {
    const coordinator = await this.coordinatorFor(speakerId)
    try {
      const info = await coordinator.AVTransportService.GetTransportInfo({ InstanceID: 0 })
      return info.CurrentTransportState
    } catch (err) {
      throw asUpstream(err)
    }
  }

  // Resolve the group coordinator for a speaker id (the coordinator UUID, or any member's UUID, as
  // reported by listSpeakers). Transport commands must target the coordinator (SPEC §4). Resolved
  // from the SAME live GetZoneGroupState read that listSpeakers uses — NOT manager.Devices, whose
  // coordinator relationships only update via UPnP zone events that a bridged network can't deliver
  // (and that SONOS_DISABLE_EVENTS turns off). Using the cache would target a stale coordinator
  // after a regroup and rip the speaker out of its group via x-rincon-queue:<stale-uuid>.
  private async coordinatorFor(speakerId: string): Promise<SonosDevice> {
    const groups = await this.readTopology()
    for (const group of groups) {
      if (group.coordinator.uuid === speakerId || group.members.some((member) => member.uuid === speakerId)) {
        const { host, port, uuid, name } = group.coordinator
        return new SonosDevice(host, port, uuid, name)
      }
    }
    throw new SonosUpstreamError(`Speaker ${speakerId} is not on the network`)
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
      if (this.seedHost !== undefined) {
        const { host, port } = parseSeedHost(this.seedHost)
        ok = await manager.InitializeFromDevice(host, port)
      } else {
        ok = await manager.InitializeWithDiscovery(DISCOVERY_TIMEOUT_SECONDS)
      }
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

// Real Sonos always listens on 1400, so a seed host is normally a bare IP. We also accept an
// explicit `host:port` (defaults to 1400) — production rarely needs it, but it lets the tests and
// the containerized fake Sonos run on an arbitrary port. IPv6 literals are not supported here.
function parseSeedHost(seed: string): { host: string; port: number } {
  const match = /^(.+):(\d+)$/.exec(seed)
  if (match) return { host: match[1] as string, port: Number(match[2]) }
  return { host: seed, port: 1400 }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Normalize any node-sonos-ts / network failure into the SonosUpstreamError the API maps to 502.
function asUpstream(err: unknown): SonosUpstreamError {
  return err instanceof SonosUpstreamError ? err : new SonosUpstreamError('Sonos did not respond')
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
