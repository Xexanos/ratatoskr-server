import type { FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from './bearer.js'

declare module 'fastify' {
  interface FastifyRequest {
    // The caller's Audiobookshelf access token, set by the bearerAuth security handler on the
    // routes that require it (SPEC section 8). The library operations forward it to ABS.
    absToken?: string
  }
}

// One handler per OpenAPI security scheme name, as fastify-openapi-glue expects. Named so a served
// major can be assembled with its own set (app.ts): /v2's bearer becomes an opaque Ratatoskr token
// under #134, which is a different check from /v1's, on the same scheme name.
export type SecurityHandlers = Record<string, (request: FastifyRequest, reply: FastifyReply, scopes: string[]) => void>

// Security handlers for fastify-openapi-glue: one method per OpenAPI security scheme name.
// glue runs the matching handler as a preHandler for every operation that requires it, and
// turns a thrown error into a 401 (SecurityError). Operations declaring `security: []` are exempt
// automatically — getHealth, listSpeakers and login in both majors, plus refresh in /v1.
export const securityHandlers = {
  // Presence check only — ABS remains the authority on validity (SPEC section 8). On success
  // the extracted token is stashed for the service methods that forward it upstream.
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.absToken = bearerToken(request)
  },
}
