import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import {
  createTokenGuard,
  SELF_VALIDATING_OPERATIONS,
  UNKNOWN_TOKEN_TOLERANT_OPERATIONS,
} from '../src/api/tokenGuard.js'

// A minimal contract shape: global bearer security, one op inheriting it, one opting out,
// one bearer-protected op that will be exempted, and one secured by a different scheme — which the
// guard must leave alone (its own scheme's handler stashes whatever `prove` would read, so proving
// it here would reject it unconditionally).
const DOCUMENT: Record<string, unknown> = {
  security: [{ bearerAuth: [] }],
  paths: {
    '/guarded': { get: { operationId: 'guardedOp' } },
    '/open': { get: { operationId: 'openOp', security: [] } },
    '/self': { post: { operationId: 'selfOp' } },
    '/other': { get: { operationId: 'otherSchemeOp', security: [{ apiKeyAuth: [] }] } },
  },
}

function request(token: string | undefined): FastifyRequest {
  return { absToken: token } as FastifyRequest
}

const reply = {} as FastifyReply

describe('createTokenGuard', () => {
  it('wraps a bearer-protected operation: validates the token, then delegates', async () => {
    const calls: string[] = []
    const prove = vi.fn(async (request: FastifyRequest) => {
      calls.push(`prove:${request.absToken}`)
    })
    const handler = vi.fn(async () => {
      calls.push('handler')
      return 'result'
    })
    const guard = createTokenGuard(DOCUMENT, prove, new Set(['selfOp']))

    const wrapped = guard('guardedOp', handler)
    await expect(wrapped(request('token-1'), reply)).resolves.toBe('result')
    // Proving strictly precedes the handler — the whole point of the guard.
    expect(calls).toEqual(['prove:token-1', 'handler'])
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ absToken: 'token-1' }), reply)
  })

  it('propagates a proving failure without invoking the handler', async () => {
    const failure = new Error('invalid token')
    const prove = vi.fn().mockRejectedValue(failure)
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, prove, new Set(['selfOp']))

    await expect(guard('guardedOp', handler)(request('bad'), reply)).rejects.toBe(failure)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns unprotected and exempt handlers unchanged', () => {
    const prove = vi.fn()
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, prove, new Set(['selfOp']))

    // Identity, not just equivalence: no wrapper means no behaviour to reason about.
    expect(guard('openOp', handler)).toBe(handler)
    expect(guard('selfOp', handler)).toBe(handler)
    // Unknown operationIds (glue's NotImplemented stubs) pass through untouched too.
    expect(guard('unknownOp', handler)).toBe(handler)
    expect(prove).not.toHaveBeenCalled()
  })

  it('leaves an operation secured by a non-bearer scheme alone', () => {
    const prove = vi.fn()
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, prove, new Set(['selfOp']))

    // Secured, but not by bearerAuth: no absToken is stashed for it, so a bearer check
    // would reject it unconditionally. Its own scheme's handler is responsible for it.
    expect(guard('otherSchemeOp', handler)).toBe(handler)
    // And exempting it is a category error the startup assertion rejects.
    expect(() => createTokenGuard(DOCUMENT, prove, new Set(['otherSchemeOp']))).toThrow(/otherSchemeOp/)
  })

  it('rejects an exempt entry that is not a bearer-protected operation', () => {
    const prove = vi.fn()
    // A renamed/removed operation must not leave a stale exemption behind.
    expect(() => createTokenGuard(DOCUMENT, prove, new Set(['goneOp']))).toThrow(/goneOp/)
    // Exempting an operation that carries no bearer requirement is equally stale.
    expect(() => createTokenGuard(DOCUMENT, prove, new Set(['openOp']))).toThrow(/openOp/)
  })

  it('accepts the real contract and the real exemption set', () => {
    // The startup assertion must hold for the shipped contract — this is the test that fails
    // when an operation in SELF_VALIDATING_OPERATIONS is renamed or its security changes.
    expect(() => createTokenGuard(frozenV1Document, vi.fn(), SELF_VALIDATING_OPERATIONS)).not.toThrow()
    // The exemptions are exactly the handlers that present the caller's token to ABS themselves.
    expect([...SELF_VALIDATING_OPERATIONS].sort()).toEqual([
      'getLibraryItem',
      'getLibraryItemCover',
      'listInProgressItems',
      'listLibraryItems',
      'startSession',
    ])
  })

  // /v2's own set, and the reason it is a different one: no handler there forwards the caller's
  // bearer upstream, so nothing is self-validating and every operation needs the resolved session.
  // What is left is the one operation the contract defines as idempotent.
  it('accepts the /v2 contract with its own exemption set, and exempts only sign-out', () => {
    expect(() => createTokenGuard(openapiDocument, vi.fn(), UNKNOWN_TOKEN_TOLERANT_OPERATIONS)).not.toThrow()
    expect([...UNKNOWN_TOKEN_TOLERANT_OPERATIONS]).toEqual(['logout'])
  })

  // The two sets are not interchangeable: on /v2 the guard is also what resolves the caller's chain,
  // so exempting the library operations there would leave them running with no absToken at all rather
  // than rejecting. Pinning the difference is cheaper than discovering it from a 500.
  it('keeps the two majors exemption sets distinct', () => {
    expect([...SELF_VALIDATING_OPERATIONS].sort()).not.toEqual([...UNKNOWN_TOKEN_TOLERANT_OPERATIONS].sort())
  })
})
