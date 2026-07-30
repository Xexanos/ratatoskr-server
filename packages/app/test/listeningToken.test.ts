import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { listeningToken } from '../src/api/service.js'

// Where a playback session reads its Audiobookshelf access token (sessionManager.ts's
// ListeningToken). The session outlives the request that started it by the length of a book, so the
// question this answers is what the supplier is still allowed to depend on by then.

describe('listeningToken', () => {
  // The whole point of the indirection: a major whose guard resolved a re-readable session hands its
  // own source through untouched, and the session picks up a chain the keep-alive loop renews under
  // it (SPEC section 8).
  it('passes a resolvable source through as it is', () => {
    const source = (): Promise<string> => Promise.resolve('from-the-store')
    const request = { absTokenSource: source, absToken: 'resolved-for-this-request' } as FastifyRequest

    expect(listeningToken(request)).toBe(source)
  })

  // And where there is no source, the token is *captured* rather than re-read off the request later:
  // the alternative keeps the whole request object alive for the session's duration and reads a
  // decorator well after the response was sent.
  it('captures the token when there is no source to re-read', async () => {
    const request = { absToken: 'user-token' } as FastifyRequest
    const supplier = listeningToken(request)

    // Stands in for whatever the framework does with a request once its response is out.
    request.absToken = 'gone'

    await expect(supplier()).resolves.toBe('user-token')
  })
})
