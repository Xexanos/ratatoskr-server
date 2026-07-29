import type { FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from './bearer.js'

declare module 'fastify' {
  interface FastifyRequest {
    // The Audiobookshelf access token this request acts with — what every upstream call carries.
    // Where it comes from is the major's auth model: under /v1 the caller sends it as its bearer,
    // under /v2 it comes out of the device session the bearer resolved to, and the caller's own
    // bearer never reaches Audiobookshelf at all (SPEC section 8).
    absToken?: string
    // /v2 only: the caller's opaque Ratatoskr token, as sent. Kept apart from absToken because the
    // two are different credentials in different namespaces — conflating them is exactly how an
    // upstream token would end up accepted as a bearer, or a Ratatoskr token forwarded to ABS.
    ratatoskrToken?: string
  }
}

// One handler per OpenAPI security scheme name, as fastify-openapi-glue expects. Named so that each
// served major is assembled with its own set (app.ts) — two majors can name the same scheme and mean
// a different check by it, which is precisely what /v1 and /v2 do.
export type SecurityHandlers = Record<string, (request: FastifyRequest, reply: FastifyReply, scopes: string[]) => void>

// glue runs the matching handler as a preHandler for every operation that requires the scheme, and
// turns a thrown error into a 401 (SecurityError). Operations declaring `security: []` are exempt
// automatically — getHealth, listSpeakers and login in both majors, plus refresh in /v1.
//
// Both sets below check for presence only. Validity is the token guard's business (tokenGuard.ts),
// because it differs per major and because an operation may be exempt from it; splitting the two
// keeps "is there a bearer at all" — the one question with the same answer everywhere — in one
// place. A missing bearer is therefore still a 401 on every protected operation, including the ones
// the guard lets past.

// /v1: the bearer IS the Audiobookshelf access token, which the handlers forward upstream and ABS
// is the sole authority on (frozen contract 1.4.0).
export const absBearerHandlers: SecurityHandlers = {
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.absToken = bearerToken(request)
  },
}

// /v2: the bearer is the opaque Ratatoskr token. It is stashed unresolved — the guard turns it into
// a device session, and thereby into the absToken the shared handlers act with. Deliberately NOT
// setting absToken here: an operation that somehow reached its handler without being proved would
// otherwise forward a Ratatoskr token to Audiobookshelf, and a 401 from ABS would make that look
// like an ordinary auth failure instead of the wiring bug it is.
export const ratatoskrBearerHandlers: SecurityHandlers = {
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.ratatoskrToken = bearerToken(request)
  },
}
