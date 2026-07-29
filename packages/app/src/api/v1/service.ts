import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { toAuthTokens, toSessionResponse, type V1AuthTokens } from '../contractMapping.js'
import { ApiService } from '../service.js'

// A started session looks the same in both majors: the handover field 1.4.0 adds to Session can only
// appear once the sync loop has rotated, which start() has just ruled out by clearing any pending
// pair — so the shared contract type describes this response exactly.
type Session = components['schemas']['Session']

// The 1.4.0-only request bodies. Declared here rather than derived from a contract: this surface is
// frozen, so these shapes cannot change, and only the served document is generated for /v1 — no
// types (see the contract package's index).
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
// dropped — the credential proxying and the rotation handover (the old protocol's specification
// lives in the frozen contract, not in SPEC section 8, which now describes the /v2 model).
//
// The split is what keeps 2.0.0's `login` honest, not just tidy: both documents declare that
// operationId at POST /auth/login, so glue would resolve /v2's to whichever method the service
// carries. Were the proxy still inherited, a /v2 client calling the login its own contract documents
// would be handed an Audiobookshelf access *and* refresh token — the one property ADR-0001 exists to
// remove, served happily and wrong. Below, /v2 has no such method, so its login falls through to
// glue's not-implemented stub until #134 mints Ratatoskr tokens there.
//
// Nothing here is a new feature, and nothing here should grow: installed app versions depend on this
// behaving exactly as it did, so the only change this file should ever see is its deletion (#137).
export class V1ApiService extends ApiService {
  // Proxied login: the credentials go to ABS and the resulting token pair goes to the client, which
  // then sends the access token as its bearer. That the device ends up holding upstream ABS tokens
  // at all is the property ADR-0001 removes — under /v2 there is no such response.
  async login(request: FastifyRequest): Promise<V1AuthTokens> {
    const { username, password } = request.body as V1LoginRequest
    return toAuthTokens(await this.abs.login(username, password))
  }

  // Proxied refresh: ABS access tokens are short-lived, so a /v1 client exchanges its pair here.
  async refresh(request: FastifyRequest): Promise<V1AuthTokens> {
    const { refreshToken } = request.body as V1RefreshRequest
    return toAuthTokens(await this.abs.refresh(refreshToken))
  }

  // The caller's refresh token is accepted and held for the session, which is what arms the rotation
  // handover in the sync loop (LISTENING_TOKEN_REFRESH_MARGIN_SECONDS, SPEC section 7 — that knob
  // serves this route alone). /v2's startSession passes no refresh token at all.
  override async startSession(request: FastifyRequest): Promise<Session> {
    const { itemId, speakerId, refreshToken } = request.body as V1StartSessionRequest
    const session = await this.sessions.start(request.absToken as string, refreshToken, itemId, speakerId)
    return toSessionResponse(session, this.apiPrefix)
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
    // Bound to Session before handing it to send(), which takes `unknown`. Every other operation
    // returns its body and so has the mapping step enforced by the method's return type; this is the
    // one response on this surface that does not, and an unmapped domain session would sail through
    // both the serializer (it drops unknown keys) and response validation (coverUrl is optional).
    const body: Session = toSessionResponse(final, this.apiPrefix)
    await reply.code(200).send(body)
  }
}
