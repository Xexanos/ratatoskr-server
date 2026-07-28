import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AbsTokens } from '../../abs/client.js'
import { ApiService } from '../service.js'

// A started session looks the same in both majors: the handover field 1.4.0 adds to Session can only
// appear once the sync loop has rotated, which start() has just ruled out by clearing any pending
// pair — so the shared contract type describes this response exactly.
type Session = components['schemas']['Session']

// The 1.4.0-only request bodies. Declared here rather than derived from a contract: this surface is
// frozen, so these shapes cannot change, and only the served document is generated for /v1 (no types
// — see the contract package's index).
interface V1LoginRequest {
  username: string
  password: string
}

interface V1RefreshRequest {
  refreshToken: string
}

interface V1StartSessionRequest {
  itemId: string
  speakerId: string
  // Optional: lets the sync loop renew the caller's ABS tokens during long unattended playback, at
  // the price of the handover protocol this whole /v1 surface exists to leave behind (ADR-0001).
  refreshToken?: string
}

// The /v1 surface: contract 1.4.0, frozen at the contract-1.4.0 tag and served in parallel until the
// sunset in ADR-0001. Everything both majors share is inherited unchanged from the /v2 service, so
// the shared operations cannot drift apart between them; what lives here is exactly what 2.0.0
// dropped — the token proxying and the rotation handover (the old protocol's specification lives in
// the frozen contract, not in SPEC section 8, which now describes the /v2 model).
//
// Nothing here is a new feature, and nothing here should grow: installed app versions depend on this
// behaving exactly as it did, so the only change this file should ever see is its deletion.
export class V1ApiService extends ApiService {
  // Proxied login: the credentials go to ABS and the resulting token pair goes to the client, which
  // then sends the access token as its bearer. That the device ends up holding upstream ABS tokens
  // at all is the property ADR-0001 removes — under /v2 there is no such response.
  async login(request: FastifyRequest): Promise<AbsTokens> {
    const { username, password } = request.body as V1LoginRequest
    return this.abs.login(username, password)
  }

  // Proxied refresh: ABS access tokens are short-lived, so a /v1 client exchanges its pair here.
  async refresh(request: FastifyRequest): Promise<AbsTokens> {
    const { refreshToken } = request.body as V1RefreshRequest
    return this.abs.refresh(refreshToken)
  }

  // The caller's refresh token is accepted and held for the session, which is what arms the
  // rotation handover in the sync loop (LISTENING_TOKEN_REFRESH_MARGIN_SECONDS, SPEC section 7 —
  // that knob serves this route alone).
  override async startSession(request: FastifyRequest): Promise<Session> {
    const { itemId, speakerId, refreshToken } = request.body as V1StartSessionRequest
    return this.sessions.start(request.absToken as string, refreshToken, itemId, speakerId, this.apiPrefix)
  }

  // 204 normally; 200 + a final Session when a rotated token pair was still pending at stop, so the
  // client can adopt it — stop discards the in-memory tokens, so this is the last chance to deliver
  // the pair. The manager returns that final Session exactly when there is one to hand over.
  override async stopSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const final = await this.sessions.stop(request.absToken as string)
    if (final !== undefined) await reply.code(200).send(final)
    else await reply.code(204).send()
  }
}
