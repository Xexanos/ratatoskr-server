import type { components } from '@ratatoskr/contract'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../../auth/authService.js'
import { bearerToken } from '../bearer.js'
import { toAuthSession } from '../contractMapping.js'
import { ApiService, type ApiServiceDeps } from '../service.js'

type AuthSession = components['schemas']['AuthSession']
type LoginRequest = components['schemas']['LoginRequest']

export interface V2ApiServiceDeps extends ApiServiceDeps {
  // Device sign-in, sign-out and bearer resolution (SPEC section 8). Only this major has one: /v1
  // proxies Audiobookshelf credentials instead and holds no sessions of its own.
  auth: AuthService
}

// The /v2 surface: contract 2.0.0, the Ratatoskr-native session model (ADR-0001). What lives here is
// the auth model — the two operations that mint and revoke the opaque token — and nothing else;
// everything a client does *with* that token is inherited from the shared service, which by then acts
// on the Audiobookshelf chain the token guard resolved (app.ts).
//
// Symmetrical with v1/service.ts, and a subclass for the same reason it gives: an auth operation in
// the shared body would answer both majors' /auth/login, and here that would hand a frozen client a
// Ratatoskr token it cannot use.
export class V2ApiService extends ApiService {
  private readonly auth: AuthService

  constructor(deps: V2ApiServiceDeps) {
    super(deps)
    this.auth = deps.auth
  }

  // Sign in: credentials in, an opaque Ratatoskr token out. No Audiobookshelf token appears in the
  // response — the server is their sole holder from here on, so the library view and progress stay
  // per-user without the client ever holding an upstream credential.
  //
  // The route is unauthenticated, so a bearer is *read* rather than required: a device replacing a
  // session it can no longer use offers the token it is replacing, and ends up with exactly one
  // session instead of leaving an orphan behind (SPEC section 8). Requiring it is impossible — a
  // first sign-in has none — and an unknown one must not be an error either, or a valid sign-in would
  // 401 over the very credential the caller was trying to discard.
  async login(request: FastifyRequest): Promise<AuthSession> {
    const { username, password } = request.body as LoginRequest
    return toAuthSession(await this.auth.signIn(username, password, offeredBearer(request)))
  }

  // Sign out: 204 always, per the contract's idempotence — an unknown or already-revoked token and an
  // unreachable Audiobookshelf all answer the same, so a client can always complete a sign-out
  // locally. Only a missing bearer is a 401, and that is the security handler's doing rather than this
  // method's. Being able to answer for a token this server does not know is exactly why the operation
  // is exempt from the token guard (tokenGuard.ts).
  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.auth.signOut(request.ratatoskrToken as string)
    await reply.code(204).send()
  }
}

// The bearer, if the caller offered one, on a route that does not require it. Distinct from
// bearerToken: here a missing or malformed header is not an error but the ordinary first sign-in.
function offeredBearer(request: FastifyRequest): string | undefined {
  try {
    return bearerToken(request)
  } catch {
    return undefined
  }
}
