import type { FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from './bearer.js'

declare module 'fastify' {
  interface FastifyRequest {
    // The caller's Audiobookshelf access token, set by the bearerAuth security handler on the
    // routes that require it (SPEC section 8). The library operations forward it to ABS.
    absToken?: string
  }
}

// A served major's handler set, keyed by scheme name (api/app.ts). Named as a type so a major can be
// given a different implementation of the same scheme — which is how the /v2 auth model will replace
// the pass-through check below without touching /v1 (#134).
export type SecurityHandlers = Record<string, (request: FastifyRequest, reply: FastifyReply, scopes: string[]) => void>

// Security handlers for fastify-openapi-glue: one method per OpenAPI security scheme name.
// glue runs the matching handler as a preHandler for every operation that requires it, and
// turns a thrown error into a 401 (SecurityError). Operations declaring `security: []`
// (getHealth, login, listSpeakers) are exempt automatically.
export const securityHandlers: SecurityHandlers = {
  // Presence check only — ABS remains the authority on validity (SPEC section 8). On success
  // the extracted token is stashed for the service methods that forward it upstream.
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.absToken = bearerToken(request)
  },
}
