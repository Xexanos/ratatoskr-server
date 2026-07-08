import type { components } from '@ratatoskr/contract'
import type { FastifyRequest } from 'fastify'
import type { AbsClient } from '../abs/client.js'
import type { Config } from '../config/index.js'
import type { SonosClient } from '../sonos/client.js'

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']
type AuthTokens = components['schemas']['AuthTokens']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type LibraryItem = components['schemas']['LibraryItem']
type Speaker = components['schemas']['Speaker']
type LoginRequest = components['schemas']['LoginRequest']
type RefreshRequest = components['schemas']['RefreshRequest']

const ABS_PING_TIMEOUT_MS = 2000

async function checkAbs(absUrl: string): Promise<DependencyStatus> {
  try {
    // Any HTTP response (even a 404) proves the host is reachable; we don't depend on ABS
    // exposing a specific health endpoint. Only a network-level failure means "unreachable".
    // The URL is not included in the detail (SPEC section 14: no upstream URLs in responses).
    const res = await fetch(absUrl, { method: 'GET', signal: AbortSignal.timeout(ABS_PING_TIMEOUT_MS) })
    // Discard the body so undici can return the connection to the pool instead of holding the
    // socket until GC — a /health poller would otherwise leak sockets.
    await res.body?.cancel()
    return { reachable: true }
  } catch {
    return { reachable: false, detail: 'Audiobookshelf did not respond' }
  }
}

// isReachable() is non-blocking: it reports the last known state and warms up discovery in the
// background, so this unauthenticated, frequently polled endpoint never waits on SSDP.
async function checkSonos(sonos: SonosClient): Promise<DependencyStatus> {
  return (await sonos.isReachable()) ? { reachable: true } : { reachable: false, detail: 'Sonos did not respond' }
}

export interface ApiServiceDeps {
  abs: AbsClient
  sonos: SonosClient
  config: Config
}

// Implements the contract operations, one method per operationId. fastify-openapi-glue resolves
// each operationId to the matching method and binds `this` to this instance, so the abs/sonos
// clients are available via constructor injection. Methods return the payload or throw a domain
// error; the central error handler (errorHandler.ts) maps thrown errors to contract responses.
export class ApiService {
  private readonly abs: AbsClient
  private readonly sonos: SonosClient
  private readonly config: Config

  constructor(deps: ApiServiceDeps) {
    this.abs = deps.abs
    this.sonos = deps.sonos
    this.config = deps.config
  }

  async getHealth(): Promise<Health> {
    const [abs, sonos] = await Promise.all([checkAbs(this.config.absUrl), checkSonos(this.sonos)])
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
}
