import type { FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from './bearer.js'

declare module 'fastify' {
  interface FastifyRequest {
    // The Audiobookshelf access token this request acts with — what every upstream call carries. It
    // comes out of the device session the caller's bearer resolved to; the bearer itself never
    // reaches Audiobookshelf at all (SPEC section 8).
    absToken?: string
    // The caller's opaque Ratatoskr token, as sent. Kept apart from absToken because the
    // two are different credentials in different namespaces — conflating them is exactly how an
    // upstream token would end up accepted as a bearer, or a Ratatoskr token forwarded to ABS.
    ratatoskrToken?: string
    // The same credential as absToken, but asked for again at each use rather than captured for
    // this request — what a playback session outliving the request has to hold (SPEC section 8),
    // so a chain the keep-alive loop renews mid-playback reaches the running sync loop. Set by the
    // token guard alongside absToken, for every operation it proves.
    absTokenSource?: () => Promise<string>
  }
}

// One handler per OpenAPI security scheme name, as fastify-openapi-glue expects. Named so that each
// served major is assembled with its own set (app.ts).
export type SecurityHandlers = Record<string, (request: FastifyRequest, reply: FastifyReply, scopes: string[]) => void>

// glue runs the matching handler as a preHandler for every operation that requires the scheme, and
// turns a thrown error into a 401 (SecurityError). Operations declaring `security: []` are exempt
// automatically — getHealth, listSpeakers and login.
//
// The handler below checks for presence only. Validity is the token guard's business (tokenGuard.ts),
// because an operation may be exempt from it; splitting the two keeps "is there a bearer at all" in
// one place. A missing bearer is therefore still a 401 on every protected operation, including the
// ones the guard lets past.

// The bearer is the opaque Ratatoskr token. It is stashed unresolved — the guard turns it into
// a device session, and thereby into the absToken the shared handlers act with. Deliberately NOT
// setting absToken here: an operation that somehow reached its handler without being proved would
// otherwise forward a Ratatoskr token to Audiobookshelf, and a 401 from ABS would make that look
// like an ordinary auth failure instead of the wiring bug it is.
export const ratatoskrBearerHandlers: SecurityHandlers = {
  bearerAuth(request: FastifyRequest, _reply: FastifyReply, _scopes: string[]): void {
    request.ratatoskrToken = bearerToken(request)
  },
}
