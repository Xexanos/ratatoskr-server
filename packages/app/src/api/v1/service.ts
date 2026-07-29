import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PlaybackSession } from '../../playback/sessionManager.js'
import { toAuthTokens, toV1SessionResponse, type MappedV1Session, type V1AuthTokens } from '../contractMapping.js'
import { ApiService } from '../service.js'

// The request bodies this surface alone accepts. Declared here rather than derived: the frozen
// document is generated as data only, with no types (see the contract package's index), and these
// shapes cannot change anyway.
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

// The /v1 surface: contract 1.4.0, frozen at the contract-1.4.0 tag (ADR-0001). What lives here is the
// credential proxying and the rotation handover; everything else is inherited from the shared service,
// so this file cannot drift away from it. The handover protocol itself is specified in the frozen
// contract, not in the SPEC.
//
// Why these operations live in a subclass rather than in the shared body: `login` is declared at
// POST /auth/login by more than one contract, and glue resolves an operationId to whichever method the
// service carries. Inherited, this proxy would answer another major's login with an Audiobookshelf
// access *and* refresh token — an upstream credential on the device, which is the property ADR-0001
// exists to remove.
//
// Nothing here is a new feature and nothing here should grow: installed app versions depend on it
// behaving exactly as it does, so the only change this file should ever see is its deletion.
export class V1ApiService extends ApiService {
  // Proxied login: the credentials go to ABS and the resulting token pair goes to the client, which
  // then sends the access token as its bearer. That the device ends up holding upstream ABS tokens at
  // all is what ADR-0001 set out to remove, and why this surface is frozen instead of extended.
  async login(request: FastifyRequest): Promise<V1AuthTokens> {
    const { username, password } = request.body as V1LoginRequest
    return toAuthTokens(await this.abs.login(username, password))
  }

  // Proxied refresh: ABS access tokens are short-lived, so a /v1 client exchanges its pair here.
  async refresh(request: FastifyRequest): Promise<V1AuthTokens> {
    const { refreshToken } = request.body as V1RefreshRequest
    return toAuthTokens(await this.abs.refresh(refreshToken))
  }

  // The one place the rotated Audiobookshelf pair is put on a wire. Every session response on this
  // surface goes through the shared methods' mapSession, so this single override is what makes the
  // handover a property of the surface that promises it (contractMapping.ts).
  protected override mapSession(session: PlaybackSession): MappedV1Session {
    return toV1SessionResponse(session, this.apiPrefix)
  }

  // The caller's refresh token is accepted and held for the session, which is what arms the rotation
  // handover in the sync loop (LISTENING_TOKEN_REFRESH_MARGIN_SECONDS, SPEC section 7 — that knob
  // serves this route alone).
  override async startSession(request: FastifyRequest): Promise<MappedV1Session> {
    const { itemId, speakerId, refreshToken } = request.body as V1StartSessionRequest
    return this.mapSession(await this.sessions.start(request.absToken as string, refreshToken, itemId, speakerId))
  }

  // 204 normally; 200 + a final Session when a rotated token pair was still pending at stop, so the
  // client can adopt it (SPEC section 8) — stop discards the in-memory tokens, so this is the last
  // chance to deliver the pair. The manager returns that final Session exactly when there is one.
  override async stopSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const final = await this.sessions.stop(request.absToken as string)
    if (final === undefined) {
      await reply.code(204).send()
      return
    }
    // Bound to this surface's own session type before handing it to send(), which takes `unknown`.
    // Every other operation has the mapping step enforced by its return type; this is the one response
    // that does not, and an unmapped domain session would sail through both the serializer (it drops
    // unknown keys) and response validation (coverUrl is optional). The shared contract type would not
    // do: it has no rotatedTokens, so it would check everything about this response except the field it
    // exists to deliver.
    const body: MappedV1Session = this.mapSession(final)
    await reply.code(200).send(body)
  }
}
