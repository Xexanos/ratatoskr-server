import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { MissingBearerError } from '../src/api/bearer.js'
import { absBearerHandlers, ratatoskrBearerHandlers } from '../src/api/security.js'

function requestWith(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}
const reply = {} as FastifyReply

// Both majors name the same security scheme and mean a different credential by it, so the shared
// property is tested once and the difference twice.
describe.each([
  ['absBearerHandlers', absBearerHandlers],
  ['ratatoskrBearerHandlers', ratatoskrBearerHandlers],
])('%s: presence checking', (_name, handlers) => {
  it('throws MissingBearerError when the Authorization header is absent', () => {
    expect(() => handlers.bearerAuth?.(requestWith({}), reply, [])).toThrow(MissingBearerError)
  })

  it('throws MissingBearerError when the scheme is not Bearer', () => {
    expect(() => handlers.bearerAuth?.(requestWith({ authorization: 'Basic xyz' }), reply, [])).toThrow(
      MissingBearerError,
    )
  })

  // RFC 7235: the auth-scheme is case-insensitive, so a client sending "bearer"/"BEARER" is not
  // malformed and must still authenticate.
  it.each(['bearer tok-123', 'BEARER tok-123'])('accepts a case-insensitive scheme (%s)', (authorization) => {
    expect(() => handlers.bearerAuth?.(requestWith({ authorization }), reply, [])).not.toThrow()
  })
})

describe('the credential each major stashes', () => {
  it('/v1 puts the bearer straight onto absToken — it IS the Audiobookshelf token', () => {
    const request = requestWith({ authorization: 'Bearer tok-123' })
    absBearerHandlers.bearerAuth?.(request, reply, [])
    expect(request.absToken).toBe('tok-123')
  })

  // The distinction the whole /v2 model rests on: the bearer is stashed unresolved, and absToken
  // stays empty until the guard has turned it into a device session (app.ts). An operation that
  // somehow reached its handler unproven must not have an ABS credential to forward.
  it('/v2 puts the bearer onto ratatoskrToken and leaves absToken unset', () => {
    const request = requestWith({ authorization: 'Bearer rtk-123' })
    ratatoskrBearerHandlers.bearerAuth?.(request, reply, [])
    expect(request.ratatoskrToken).toBe('rtk-123')
    expect(request.absToken).toBeUndefined()
  })
})
