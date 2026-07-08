import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { MissingBearerError } from '../src/api/bearer.js'
import { securityHandlers } from '../src/api/security.js'

function requestWith(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}
const reply = {} as FastifyReply

describe('bearerAuth security handler', () => {
  it('extracts a valid Bearer token onto request.absToken', () => {
    const request = requestWith({ authorization: 'Bearer tok-123' })
    securityHandlers.bearerAuth(request, reply, [])
    expect(request.absToken).toBe('tok-123')
  })

  it('throws MissingBearerError when the Authorization header is absent', () => {
    expect(() => securityHandlers.bearerAuth(requestWith({}), reply, [])).toThrow(MissingBearerError)
  })

  it('throws MissingBearerError when the scheme is not Bearer', () => {
    expect(() => securityHandlers.bearerAuth(requestWith({ authorization: 'Basic xyz' }), reply, [])).toThrow(
      MissingBearerError,
    )
  })
})
