import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AbsClient } from '../abs/client.js'
import type { SessionManager } from '../playback/sessionManager.js'
import type { SonosClient } from '../sonos/client.js'

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']
type AuthTokens = components['schemas']['AuthTokens']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type LibraryItem = components['schemas']['LibraryItem']
type Speaker = components['schemas']['Speaker']
type LoginRequest = components['schemas']['LoginRequest']
type RefreshRequest = components['schemas']['RefreshRequest']
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
// post-startup health check reads as "come back shortly", not as a Sonos outage.
async function checkSonos(sonos: SonosClient): Promise<DependencyStatus> {
  const reachable = await sonos.isReachable()
  if (reachable === undefined) return { reachable: false, detail: 'probing, retry shortly' }
  return reachable ? { reachable: true } : { reachable: false, detail: 'Sonos did not respond' }
}

export interface ApiServiceDeps {
  abs: AbsClient
  sonos: SonosClient
  sessions: SessionManager
}

// Implements the contract operations, one method per operationId. fastify-openapi-glue resolves
// each operationId to the matching method and binds `this` to this instance, so the abs/sonos
// clients are available via constructor injection. Methods return the payload or throw a domain
// error; the central error handler (errorHandler.ts) maps thrown errors to contract responses.
export class ApiService {
  private readonly abs: AbsClient
  private readonly sonos: SonosClient
  private readonly sessions: SessionManager

  constructor(deps: ApiServiceDeps) {
    this.abs = deps.abs
    this.sonos = deps.sonos
    this.sessions = deps.sessions
  }

  async getHealth(): Promise<Health> {
    const [abs, sonos] = await Promise.all([checkAbs(this.abs), checkSonos(this.sonos)])
    // SPEC section 14: /health reports only coarse reachability — deliberately no version and
    // no URLs, since it is unauthenticated on an untrusted LAN.
    return { status: abs.reachable && sonos.reachable ? 'ok' : 'degraded', abs, sonos }
  }

  async login(request: FastifyRequest): Promise<AuthTokens> {
    const { username, password } = request.body as LoginRequest
    return this.abs.login(username, password)
  }

  async refresh(request: FastifyRequest): Promise<AuthTokens> {
    const { refreshToken } = request.body as RefreshRequest
    return this.abs.refresh(refreshToken)
  }

  async listLibraryItems(request: FastifyRequest): Promise<LibraryItemPage> {
    const { q: searchQuery, limit, cursor } = request.query as { q?: string; limit: number; cursor?: string }
    return this.abs.listItems(request.absToken as string, { searchQuery, limit, cursor })
  }

  async getLibraryItem(request: FastifyRequest): Promise<LibraryItem> {
    const { itemId } = request.params as { itemId: string }
    return this.abs.getItem(request.absToken as string, itemId)
  }

  async listSpeakers(): Promise<Speaker[]> {
    return this.sonos.listSpeakers()
  }

  // --- Playback (SPEC sections 4 and 5) ---

  // getCurrentSession/stopSession never forward the caller's token to ABS on their own, so validate
  // it upstream first — otherwise the presence-only bearer check would let any non-empty bearer read
  // or stop the session on the untrusted LAN (SPEC section 14). startSession needs no explicit check:
  // it already presents the token to ABS via getPlaybackManifest, which 401s an invalid one.
  async getCurrentSession(request: FastifyRequest): Promise<Session> {
    await this.abs.validateToken(request.absToken as string)
    return this.sessions.current(request.absToken as string)
  }

  async startSession(request: FastifyRequest): Promise<Session> {
    const { itemId, speakerId, refreshToken } = request.body as StartSessionRequest
    return this.sessions.start(request.absToken as string, refreshToken, itemId, speakerId)
  }

  // 204 normally; 200 + a final Session when a rotated token pair was still pending at stop, so the
  // client can adopt it (SPEC section 8) — stop discards the in-memory tokens, so this is the last
  // chance to deliver the pair.
  async stopSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.abs.validateToken(request.absToken as string)
    const final = await this.sessions.stop(request.absToken as string)
    if (final !== undefined) await reply.code(200).send(final)
    else await reply.code(204).send()
  }

  // pause/resume/seek validate the bearer upstream first (like getCurrentSession/stopSession), then
  // command Sonos and write the reached position back to ABS (SPEC section 5). The caller's token is
  // forwarded so an adopted rotated pair stops being redelivered (SPEC section 8).
  async pauseSession(request: FastifyRequest): Promise<Session> {
    await this.abs.validateToken(request.absToken as string)
    return this.sessions.pause(request.absToken as string)
  }

  async resumeSession(request: FastifyRequest): Promise<Session> {
    await this.abs.validateToken(request.absToken as string)
    return this.sessions.resume(request.absToken as string)
  }

  async seekSession(request: FastifyRequest): Promise<Session> {
    await this.abs.validateToken(request.absToken as string)
    const { positionSeconds } = request.body as SeekRequest
    return this.sessions.seek(request.absToken as string, positionSeconds)
  }
}
