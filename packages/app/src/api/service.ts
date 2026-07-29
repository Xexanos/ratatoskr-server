import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AbsClient } from '../abs/client.js'
import type { PlaybackSession, SessionManager } from '../playback/sessionManager.js'
import type { SonosClient } from '../sonos/client.js'
import {
  type MappedSession,
  toLibraryItem,
  toLibraryItemList,
  toLibraryItemPage,
  toSessionResponse,
  toSpeaker,
} from './contractMapping.js'

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type LibraryItemList = components['schemas']['LibraryItemList']
type LibraryItem = components['schemas']['LibraryItem']
type Speaker = components['schemas']['Speaker']
type Session = components['schemas']['Session']
type StartSessionRequest = components['schemas']['StartSessionRequest']
type SeekRequest = components['schemas']['SeekRequest']

async function checkAbs(abs: AbsClient): Promise<DependencyStatus> {
  // probe() verifies the host is genuinely Audiobookshelf (GET /ping) rather than accepting any
  // response, and reuses the client's TLS trust settings. The URL is not included in the detail
  // (SPEC section 14: no upstream URLs in responses).
  switch (await abs.probe()) {
    case 'ok':
      return { reachable: true }
    case 'not-audiobookshelf':
      return { reachable: false, detail: 'host responded but is not Audiobookshelf' }
    default:
      return { reachable: false, detail: 'Audiobookshelf did not respond' }
  }
}

// isReachable() is non-blocking: it reports the last known state and warms up discovery in the
// background, so this unauthenticated, frequently polled endpoint never waits on SSDP. Before
// the very first probe settles there is no known state yet — report that as probing so a single
// post-startup health check reads as "come back shortly", not as a Sonos outage. The raw
// tri-state is returned alongside the response shape so getHealth can tell "still probing" apart
// from "confirmed unreachable" (only the latter should drag the overall status to degraded).
async function checkSonos(sonos: SonosClient): Promise<{ status: DependencyStatus; reachable: boolean | undefined }> {
  const reachable = await sonos.isReachable()
  if (reachable === undefined) return { status: { reachable: false, detail: 'probing, retry shortly' }, reachable }
  return {
    status: reachable ? { reachable: true } : { reachable: false, detail: 'Sonos did not respond' },
    reachable,
  }
}

export interface ApiServiceDeps {
  abs: AbsClient
  sonos: SonosClient
  sessions: SessionManager
  // The version-mount prefix this instance is served under. Injected, so the URLs its responses carry
  // resolve against the surface the request arrived on (contractMapping.ts's coverPathFor).
  apiPrefix: string
}

// Implements the contract operations, one method per operationId. fastify-openapi-glue resolves
// each operationId to the matching method and binds `this` to this instance, so the abs/sonos
// clients are available via constructor injection. Methods return the payload or throw a domain
// error; the central error handler (errorHandler.ts) maps thrown errors to contract responses.
//
// Every served major runs these operations from this one body, so they cannot drift apart by
// accident — which also means a change here reaches every mount. The members below are protected for
// the subclass in v1/, not for open extension.
export class ApiService {
  protected readonly abs: AbsClient
  private readonly sonos: SonosClient
  protected readonly sessions: SessionManager
  protected readonly apiPrefix: string

  constructor(deps: ApiServiceDeps) {
    this.abs = deps.abs
    this.sonos = deps.sonos
    this.sessions = deps.sessions
    this.apiPrefix = deps.apiPrefix
  }

  async getHealth(): Promise<Health> {
    const [abs, sonosCheck] = await Promise.all([checkAbs(this.abs), checkSonos(this.sonos)])
    // SPEC section 14: /health reports only coarse reachability — deliberately no version and
    // no URLs, since it is unauthenticated on an untrusted LAN.
    // A still-probing Sonos (reachable === undefined, only ever right after startup) must not
    // drag the overall status to degraded — that would be a false alarm for the boot window
    // this state exists to avoid, so only a *confirmed* unreachable Sonos (=== false) counts.
    const sonosDown = sonosCheck.reachable === false
    return { status: abs.reachable && !sonosDown ? 'ok' : 'degraded', abs, sonos: sonosCheck.status }
  }

  // No auth operations here: both majors declare `login` at POST /auth/login and mean incompatible
  // things by it, so each one's auth model lives in its own subclass — see v1/service.ts, which
  // carries the reasoning.

  async listLibraryItems(request: FastifyRequest): Promise<LibraryItemPage> {
    const { q: searchQuery, limit, cursor } = request.query as { q?: string; limit: number; cursor?: string }
    const page = await this.abs.listItems(request.absToken as string, { searchQuery, limit, cursor })
    return toLibraryItemPage(page, this.apiPrefix)
  }

  async getLibraryItem(request: FastifyRequest): Promise<LibraryItem> {
    const { itemId } = request.params as { itemId: string }
    const detail = await this.abs.getItem(request.absToken as string, itemId)
    return toLibraryItem(detail, this.apiPrefix)
  }

  // Cover proxy (SPEC section 2 / section 8). Forwards the caller's token to ABS, which both fetches
  // the image and validates the token (so an invalid token → 401, a missing item → 404). The body is
  // sent as a Buffer deliberately: Fastify skips preSerialization for Buffer payloads, so the dev-mode
  // response validator does not try to validate raw image bytes against the image/* schema. The
  // response carries no caching guidance (issue #100): ABS sends no cache headers on this path and
  // the only client caches independently of them, so there is nothing worth minting or forwarding.
  async getLibraryItemCover(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { itemId } = request.params as { itemId: string }
    const { h } = request.query as { h?: number }
    const cover = await this.abs.getItemCover(request.absToken as string, itemId, h)
    await reply.type(cover.contentType).send(cover.body)
  }

  // In-progress shelf (SPEC section 2): a bounded, non-paginated LibraryItemList. Forwards the
  // caller's token (which ABS validates), and Fastify applies the querystring `default` for `limit`.
  async listInProgressItems(request: FastifyRequest): Promise<LibraryItemList> {
    const { limit } = request.query as { limit: number }
    const books = await this.abs.listInProgressItems(request.absToken as string, limit)
    return toLibraryItemList(books, this.apiPrefix)
  }

  async listSpeakers(): Promise<Speaker[]> {
    return (await this.sonos.listSpeakers()).map(toSpeaker)
  }

  // --- Playback (SPEC sections 4 and 5) ---

  // Every session response goes through here, so a surface that puts an extra field on the wire says
  // so in one place. This mapper cannot produce the rotated Audiobookshelf pair at all: leaving that
  // to the serializer would make "no upstream credential on the wire" (SPEC section 8) depend on every
  // response having a declared schema (contractMapping.ts).
  protected mapSession(session: PlaybackSession): MappedSession {
    return toSessionResponse(session, this.apiPrefix)
  }

  // The session methods never forward the caller's token to ABS on their own (they act on the
  // session's stored listening token), so the token guard validates it upstream before dispatch —
  // see tokenGuard.ts. startSession is the exception (self-validating): it presents the token to
  // ABS via getPlaybackManifest, which 401s an invalid one.
  async getCurrentSession(request: FastifyRequest): Promise<Session> {
    return this.mapSession(await this.sessions.current(request.absToken as string))
  }

  // No refresh token is passed on, so the sync loop runs on whatever access token this request
  // carried and playback outlives it only as long as that token does. On /v1 that is the caller's own
  // bearer, since 1.4.0 declares no refresh token on this request; on /v2 it is the device session's
  // chain, and renewing it mid-session belongs to the keep-alive loop, which does not exist yet —
  // until it does, a session started on /v2 holds the access token it started with (SPEC section 8).
  async startSession(request: FastifyRequest): Promise<Session> {
    const { itemId, speakerId } = request.body as StartSessionRequest
    const session = await this.sessions.start(request.absToken as string, undefined, itemId, speakerId)
    return this.mapSession(session)
  }

  // Always 204: no token pair travels to the client on this surface, so the final Session the manager
  // returns has nothing left to deliver and is discarded (SPEC section 8, which also records what that
  // costs when a session is shared with a surface that does deliver one).
  async stopSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.sessions.stop(request.absToken as string)
    await reply.code(204).send()
  }

  // pause/resume/seek command Sonos and write the reached position back to ABS (SPEC section 5).
  async pauseSession(request: FastifyRequest): Promise<Session> {
    return this.mapSession(await this.sessions.pause(request.absToken as string))
  }

  async resumeSession(request: FastifyRequest): Promise<Session> {
    return this.mapSession(await this.sessions.resume(request.absToken as string))
  }

  async seekSession(request: FastifyRequest): Promise<Session> {
    const { positionSeconds } = request.body as SeekRequest
    const session = await this.sessions.seek(request.absToken as string, positionSeconds)
    return this.mapSession(session)
  }
}
