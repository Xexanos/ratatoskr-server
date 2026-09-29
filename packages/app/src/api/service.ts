import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AbsClient } from '../abs/client.js'
import type { ListeningToken, SessionManager } from '../playback/sessionManager.js'
import type { SonosClient } from '../sonos/client.js'
import {
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
// the subclass in v2/, not for open extension.
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

  // No auth operations here: the auth model belongs to the major, so it lives in its own subclass -
  // see v2/service.ts.

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

  // The session methods act on the session's own listening token rather than forwarding the caller's,
  // so they take nothing from the request but what the operation names. The token guard has already
  // proved the bearer and resolved the chain (tokenGuard.ts).
  async getCurrentSession(): Promise<Session> {
    return toSessionResponse(await this.sessions.current(), this.apiPrefix)
  }

  // What the session is given is where to *read* the access token (`absTokenSource`), not the token
  // itself - so the chain the keep-alive loop renews under it reaches a session that is already
  // running, and long unattended playback keeps writing progress past the access token it started
  // with (SPEC section 8).
  async startSession(request: FastifyRequest): Promise<Session> {
    const { itemId, speakerId } = request.body as StartSessionRequest
    const session = await this.sessions.start(request.absTokenSource as ListeningToken, itemId, speakerId)
    return toSessionResponse(session, this.apiPrefix)
  }

  async stopSession(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.sessions.stop()
    await reply.code(204).send()
  }

  // pause/resume/seek command Sonos and write the reached position back to ABS (SPEC section 5).
  async pauseSession(): Promise<Session> {
    return toSessionResponse(await this.sessions.pause(), this.apiPrefix)
  }

  async resumeSession(): Promise<Session> {
    return toSessionResponse(await this.sessions.resume(), this.apiPrefix)
  }

  async seekSession(request: FastifyRequest): Promise<Session> {
    const { positionSeconds } = request.body as SeekRequest
    return toSessionResponse(await this.sessions.seek(positionSeconds), this.apiPrefix)
  }
}
