import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { MissingBearerError } from '../src/api/bearer.js'
import { ratatoskrBearerHandlers } from '../src/api/security.js'

function requestWith(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}
const reply = {} as FastifyReply

describe('ratatoskrBearerHandlers: presence checking', () => {
  const handlers = ratatoskrBearerHandlers

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

describe('the credential /v2 stashes', () => {
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
