import type { components } from '@ratatoskr/contract'
import type { FastifyRequest } from 'fastify'
import type { AbsClient } from '../abs/client.js'
import type { SonosClient } from '../sonos/client.js'

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']
type AuthTokens = components['schemas']['AuthTokens']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type LibraryItem = components['schemas']['LibraryItem']
type Speaker = components['schemas']['Speaker']
type LoginRequest = components['schemas']['LoginRequest']
type RefreshRequest = components['schemas']['RefreshRequest']

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
// background, so this unauthenticated, frequently polled endpoint never waits on SSDP.
async function checkSonos(sonos: SonosClient): Promise<DependencyStatus> {
  return (await sonos.isReachable()) ? { reachable: true } : { reachable: false, detail: 'Sonos did not respond' }
}

export interface ApiServiceDeps {
  abs: AbsClient
  sonos: SonosClient
}

// Implements the contract operations, one method per operationId. fastify-openapi-glue resolves
// each operationId to the matching method and binds `this` to this instance, so the abs/sonos
// clients are available via constructor injection. Methods return the payload or throw a domain
// error; the central error handler (errorHandler.ts) maps thrown errors to contract responses.
export class ApiService {
  private readonly abs: AbsClient
  private readonly sonos: SonosClient

  constructor(deps: ApiServiceDeps) {
    this.abs = deps.abs
    this.sonos = deps.sonos
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
}
