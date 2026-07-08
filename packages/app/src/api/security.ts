import type { FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from './bearer.js'

declare module 'fastify' {
  interface FastifyRequest {
    // The caller's Audiobookshelf access token, set by the bearerAuth security handler on the
    // routes that require it (SPEC section 8). The library operations forward it to ABS.
    absToken?: string
  }
}

// Security handlers for fastify-openapi-glue: one method per OpenAPI security scheme name.
// glue runs the matching handler as a preHandler for every operation that requires it, and
// turns a thrown error into a 401 (SecurityError). Operations declaring `security: []`
// (getHealth, login, refresh) are exempt automatically.
export const securityHandlers = {
  // Presence check only — ABS remains the authority on validity (SPEC section 8). On success
  // the extracted token is stashed for the service methods that forward it upstream.
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.absToken = bearerToken(request)
  },
}
