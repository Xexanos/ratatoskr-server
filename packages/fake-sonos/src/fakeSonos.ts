import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { hmsToSeconds, secondsToHms } from './time.js'

// A stateful UPnP/SOAP double for one Sonos speaker, owned by this repo (docs/testing.md). It is
// a REAL HTTP server that @svrooij/sonos talks to via InitializeFromDevice(host, port) — point the
// SonosClient at it with SONOS_SEED_HOST=host:port and set SONOS_DISABLE_EVENTS=1 so the library
// skips UPnP eventing (the double implements only the control SOAP, not eventing). It reproduces
// the SPEC §4 quirks: DIDL-Lite metadata is REQUIRED on enqueue AND on an http(s) transport URI
// (a bare URL is rejected like the real 714), TrackDuration is always 0:00:00, and RelTime is the
// authoritative elapsed position.
//
// One behavioral definition, consumed two ways: imported in-process by the server's tests, and
// run standalone (main.ts) inside the container image the central E2E repo consumes — so the
// component tests and the E2E stack cannot drift apart.

export interface EnqueuedTrack {
  uri: string
  /** The DIDL-Lite metadata as received (unescaped once from the SOAP body). */
  metadata: string
}

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/'

function soap(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="${SOAP_NS}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`
}

function fault(errorCode: number): string {
  return soap(
    `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>` +
      `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${errorCode}</errorCode></UPnPError>` +
      `</detail></s:Fault>`,
  )
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unesc(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function param(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return match ? match[1] : undefined
}

// SPEC §4 quirk shared by enqueue and transport-URI: DIDL-Lite must carry the mime via a
// <res protocolInfo="http-get:*:<mime>:*"> resource, else real Sonos answers UPnP 714. (Real
// hardware would sniff a file extension as a fallback, but ABS raw-file URLs never carry one, so
// the double is deliberately stricter: no valid DIDL means 714, full stop.)
function hasDidlMime(metadata: string): boolean {
  return /protocolInfo="http-get:\*:[^"]+:\*"/.test(metadata)
}

export interface FakeSonosOptions {
  uuid?: string
  roomName?: string
  /** Bind address. In-process tests keep the loopback default; the container binds 0.0.0.0. */
  host?: string
  /** Fixed listen port; 0 (default) picks an ephemeral one — right for parallel test workers. */
  port?: number
  /**
   * Host advertised in the zone-group Location URL (defaults to the bind address). A
   * containerized fake binds 0.0.0.0 but must advertise its externally reachable name.
   */
  advertiseHost?: string
  /**
   * When true, GetPositionInfo advances RelTime with the wall clock while PLAYING (frozen on
   * pause/stop, re-anchored on seek). Off by default so in-process tests keep the position they
   * set manually; the E2E container enables it (FAKE_ADVANCE=1) so real playback progresses and
   * the server's sync loop has a moving position to write back to ABS.
   */
  advanceWhilePlaying?: boolean
}

export class FakeSonos {
  private server: Server | undefined
  private readonly host: string
  private port: number
  private readonly advertiseHost: string
  private readonly uuid: string
  private readonly roomName: string
  private readonly advanceWhilePlaying: boolean
  // Wall-clock anchor for auto-advance: set to Date.now() while PLAYING iff advanceWhilePlaying,
  // undefined otherwise (so with the flag off, currentRelSeconds() is exactly relTimeSeconds).
  private playStartedAt: number | undefined

  // Observable state, for assertions and to answer polls.
  queue: EnqueuedTrack[] = []
  transportUri = ''
  transportState = 'STOPPED'
  currentTrack = 1 // 1-based, as Sonos reports
  relTimeSeconds = 0
  readonly actions: string[] = []

  // Test hooks for the seek retry logic:
  // - the next N Seek requests fault with UPnP 714 (mimics a TRANSITIONING transport rejecting seek)
  seekFaultsRemaining = 0
  // - when set, GetPositionInfo reports this instead of the seeked track/offset (force off-target)
  positionReport: { track: number; relSeconds: number } | undefined = undefined

  constructor(options: FakeSonosOptions = {}) {
    this.uuid = options.uuid ?? 'RINCON_FAKE000001400'
    this.roomName = options.roomName ?? 'Test Room'
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
    this.advertiseHost = options.advertiseHost ?? this.host
    this.advanceWhilePlaying = options.advanceWhilePlaying ?? false
  }

  /**
   * Reported elapsed position. With advanceWhilePlaying off this is just relTimeSeconds (no
   * behaviour change). With it on, while PLAYING it adds the whole seconds elapsed since the
   * play/seek anchor, so a real E2E session's position moves without a test poking it.
   */
  private currentRelSeconds(): number {
    if (this.advanceWhilePlaying && this.transportState === 'PLAYING' && this.playStartedAt !== undefined) {
      return this.relTimeSeconds + Math.floor((Date.now() - this.playStartedAt) / 1000)
    }
    return this.relTimeSeconds
  }

  get speakerId(): string {
    return this.uuid
  }

  async start(): Promise<{ host: string; port: number; seedHost: string }> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server?.listen(this.port, this.host, resolve))
    this.port = (this.server.address() as AddressInfo).port
    return { host: this.host, port: this.port, seedHost: `${this.host}:${this.port}` }
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server = undefined
  }

  /**
   * Restore the pristine post-start state (empty queue, stopped transport, hooks cleared) so
   * tests sharing one instance are order-independent. The HTTP server keeps running.
   */
  reset(): void {
    this.queue = []
    this.transportUri = ''
    this.transportState = 'STOPPED'
    this.currentTrack = 1
    this.relTimeSeconds = 0
    this.actions.length = 0
    this.seekFaultsRemaining = 0
    this.positionReport = undefined
    this.playStartedAt = undefined
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const action = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#')[1] ?? ''
      res.setHeader('Content-Type', 'text/xml; charset=utf-8')
      try {
        const reply = this.dispatch(req.url ?? '', action, body)
        if (reply === undefined) {
          res.statusCode = 500
          res.end(fault(401))
          return
        }
        res.end(reply)
      } catch {
        res.statusCode = 500
        res.end(fault(714))
      }
    })
  }

  private dispatch(url: string, action: string, body: string): string | undefined {
    if (url === '/ZoneGroupTopology/Control' && action === 'GetZoneGroupState') {
      return this.getZoneGroupState()
    }
    if (url !== '/MediaRenderer/AVTransport/Control') return undefined
    this.actions.push(action)
    switch (action) {
      case 'RemoveAllTracksFromQueue':
        this.queue = []
        return soap(`<u:RemoveAllTracksFromQueueResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'AddURIToQueue':
        return this.addUriToQueue(body)
      case 'SetAVTransportURI':
        return this.setAvTransportUri(body)
      case 'Play':
        if (this.advanceWhilePlaying) this.playStartedAt = Date.now()
        this.transportState = 'PLAYING'
        return soap(`<u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Pause':
        this.relTimeSeconds = this.currentRelSeconds() // fold elapsed before freezing (no-op if flag off)
        this.playStartedAt = undefined
        this.transportState = 'PAUSED_PLAYBACK'
        return soap(`<u:PauseResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Stop':
        this.relTimeSeconds = this.currentRelSeconds()
        this.playStartedAt = undefined
        this.transportState = 'STOPPED'
        return soap(`<u:StopResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Seek':
        return this.seek(body)
      case 'GetPositionInfo':
        return this.getPositionInfo()
      case 'GetTransportInfo':
        return soap(
          `<u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
            `<CurrentTransportState>${this.transportState}</CurrentTransportState>` +
            `<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>` +
            `</u:GetTransportInfoResponse>`,
        )
      default:
        return undefined
    }
  }

  private setAvTransportUri(body: string): string {
    const uri = param(body, 'CurrentURI') ?? ''
    // Same quirk as addUriToQueue (see hasDidlMime): pointing the transport straight at a bare
    // http(s) URL without DIDL-Lite is answered with UPnP 714 by real Sonos — a server regression
    // that skips the queue must fail here too. Rincon schemes (x-rincon-queue:<uuid>#0)
    // legitimately travel without metadata.
    const metadata = unesc(param(body, 'CurrentURIMetaData') ?? '')
    if (/^https?:\/\//i.test(uri) && !hasDidlMime(metadata)) {
      throw new Error('illegal mime-type (bare http transport URI without DIDL-Lite)')
    }
    this.transportUri = uri
    return soap(`<u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
  }

  private addUriToQueue(body: string): string {
    const uri = param(body, 'EnqueuedURI') ?? ''
    const rawMeta = param(body, 'EnqueuedURIMetaData') ?? ''
    const metadata = unesc(rawMeta)
    // SPEC §4 quirk (see hasDidlMime): a bare URL with no DIDL-Lite carrying the mime is illegal —
    // real Sonos answers UPnP 714.
    if (!hasDidlMime(metadata)) {
      throw new Error('illegal mime-type (missing DIDL-Lite)')
    }
    this.queue.push({ uri, metadata })
    const trackNumber = this.queue.length
    return soap(
      `<u:AddURIToQueueResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
        `<FirstTrackNumberEnqueued>${trackNumber}</FirstTrackNumberEnqueued>` +
        `<NumTracksAdded>1</NumTracksAdded><NewQueueLength>${trackNumber}</NewQueueLength>` +
        `</u:AddURIToQueueResponse>`,
    )
  }

  private seek(body: string): string {
    if (this.seekFaultsRemaining > 0) {
      this.seekFaultsRemaining -= 1
      throw new Error('transport is transitioning') // -> UPnP 714 fault (handled in handle())
    }
    const unit = param(body, 'Unit')
    const target = param(body, 'Target') ?? ''
    if (unit === 'TRACK_NR') this.currentTrack = Number(target) || 1
    else if (unit === 'REL_TIME') {
      this.relTimeSeconds = hmsToSeconds(target)
      // re-anchor so auto-advance resumes from the seeked position (no-op if flag off)
      if (this.advanceWhilePlaying && this.transportState === 'PLAYING') this.playStartedAt = Date.now()
    }
    return soap(`<u:SeekResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
  }

  private getPositionInfo(): string {
    const track = this.positionReport ? this.positionReport.track : this.currentTrack
    const relSeconds = this.positionReport ? this.positionReport.relSeconds : this.currentRelSeconds()
    return soap(
      `<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
        `<Track>${track}</Track>` +
        // Quirk: streamed files report a zero TrackDuration — callers must not trust it (SPEC §4).
        `<TrackDuration>0:00:00</TrackDuration><TrackMetaData></TrackMetaData>` +
        `<TrackURI>${esc(this.queue[this.currentTrack - 1]?.uri ?? '')}</TrackURI>` +
        `<RelTime>${secondsToHms(relSeconds)}</RelTime>` +
        `<AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>1</RelCount><AbsCount>1</AbsCount>` +
        `</u:GetPositionInfoResponse>`,
    )
  }

  private getZoneGroupState(): string {
    const location = `http://${this.advertiseHost}:${this.port}/xml/device_description.xml`
    const inner =
      `<ZoneGroupState><ZoneGroups>` +
      `<ZoneGroup Coordinator="${this.uuid}" ID="${this.uuid}:1">` +
      `<ZoneGroupMember UUID="${this.uuid}" Location="${location}" ZoneName="${this.roomName}" ` +
      `Invisible="0" SoftwareVersion="80.0.0" />` +
      `</ZoneGroup></ZoneGroups></ZoneGroupState>`
    return soap(
      `<u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">` +
        `<ZoneGroupState>${esc(inner)}</ZoneGroupState></u:GetZoneGroupStateResponse>`,
    )
  }
}
