import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { hmsToSeconds, secondsToHms } from './time.js'

// A stateful UPnP/SOAP double for one Sonos speaker, owned by this repo (docs/testing.md). It is
// a REAL HTTP server that @svrooij/sonos talks to via InitializeFromDevice(host, port) — point the
// SonosClient at it with SONOS_SEED_HOST=host:port and set SONOS_DISABLE_EVENTS=1 so the library
// skips UPnP eventing (the double implements only the control SOAP, not eventing). It reproduces
// the SPEC §4 quirks: DIDL-Lite metadata is REQUIRED to enqueue (a bare URL is rejected like the
// real 714), TrackDuration is always 0:00:00, and RelTime is the authoritative elapsed position.
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
}

export class FakeSonos {
  private server: Server | undefined
  private readonly host: string
  private port: number
  private readonly advertiseHost: string
  private readonly uuid: string
  private readonly roomName: string

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
        this.transportUri = param(body, 'CurrentURI') ?? ''
        return soap(`<u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Play':
        this.transportState = 'PLAYING'
        return soap(`<u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Pause':
        this.transportState = 'PAUSED_PLAYBACK'
        return soap(`<u:PauseResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
      case 'Stop':
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

  private addUriToQueue(body: string): string {
    const uri = param(body, 'EnqueuedURI') ?? ''
    const rawMeta = param(body, 'EnqueuedURIMetaData') ?? ''
    const metadata = unesc(rawMeta)
    // SPEC §4 quirk: a bare URL (no DIDL-Lite carrying the mime) is illegal — real Sonos answers
    // UPnP 714. Reject anything without a <res protocolInfo="http-get:*:<mime>:*"> resource.
    if (!/protocolInfo="http-get:\*:[^"]+:\*"/.test(metadata)) {
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
    else if (unit === 'REL_TIME') this.relTimeSeconds = hmsToSeconds(target)
    return soap(`<u:SeekResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>`)
  }

  private getPositionInfo(): string {
    const track = this.positionReport ? this.positionReport.track : this.currentTrack
    const relSeconds = this.positionReport ? this.positionReport.relSeconds : this.relTimeSeconds
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
