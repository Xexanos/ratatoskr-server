import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { openapiDocument } from '@ratatoskr/contract'
import { createTokenGuard, SELF_VALIDATING_OPERATIONS } from '../src/api/tokenGuard.js'

// A minimal contract shape: global bearer security, one op inheriting it, one opting out,
// one bearer-protected op that will be exempted as self-validating, and one secured by a
// different scheme — which the guard must leave alone (only the bearerAuth handler sets
// request.absToken, so a bearer check against it would 401 unconditionally).
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
    const validate = vi.fn(async (token: string) => {
      calls.push(`validate:${token}`)
    })
    const handler = vi.fn(async () => {
      calls.push('handler')
      return 'result'
    })
    const guard = createTokenGuard(DOCUMENT, validate, new Set(['selfOp']))

    const wrapped = guard('guardedOp', handler)
    await expect(wrapped(request('token-1'), reply)).resolves.toBe('result')
    // Validation strictly precedes the handler — the whole point of the guard.
    expect(calls).toEqual(['validate:token-1', 'handler'])
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ absToken: 'token-1' }), reply)
  })

  it('propagates a validation failure without invoking the handler', async () => {
    const failure = new Error('invalid token')
    const validate = vi.fn().mockRejectedValue(failure)
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, validate, new Set(['selfOp']))

    await expect(guard('guardedOp', handler)(request('bad'), reply)).rejects.toBe(failure)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns unprotected and self-validating handlers unchanged', () => {
    const validate = vi.fn()
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, validate, new Set(['selfOp']))

    // Identity, not just equivalence: no wrapper means no behaviour to reason about.
    expect(guard('openOp', handler)).toBe(handler)
    expect(guard('selfOp', handler)).toBe(handler)
    // Unknown operationIds (glue's NotImplemented stubs) pass through untouched too.
    expect(guard('unknownOp', handler)).toBe(handler)
    expect(validate).not.toHaveBeenCalled()
  })

  it('leaves an operation secured by a non-bearer scheme alone', () => {
    const validate = vi.fn()
    const handler = vi.fn()
    const guard = createTokenGuard(DOCUMENT, validate, new Set(['selfOp']))

    // Secured, but not by bearerAuth: no absToken is stashed for it, so a bearer check
    // would reject it unconditionally. Its own scheme's handler is responsible for it.
    expect(guard('otherSchemeOp', handler)).toBe(handler)
    // And exempting it as self-validating is a category error the startup assertion rejects.
    expect(() => createTokenGuard(DOCUMENT, validate, new Set(['otherSchemeOp']))).toThrow(/otherSchemeOp/)
  })

  it('rejects a self-validating entry that is not a bearer-protected operation', () => {
    const validate = vi.fn()
    // A renamed/removed operation must not leave a stale exemption behind.
    expect(() => createTokenGuard(DOCUMENT, validate, new Set(['goneOp']))).toThrow(/goneOp/)
    // Exempting an operation that carries no bearer requirement is equally stale.
    expect(() => createTokenGuard(DOCUMENT, validate, new Set(['openOp']))).toThrow(/openOp/)
  })

  it('accepts the real contract and the real exemption set', () => {
    // The startup assertion must hold for the shipped contract — this is the test that fails
    // when an operation in SELF_VALIDATING_OPERATIONS is renamed or its security changes.
    expect(() => createTokenGuard(openapiDocument, vi.fn())).not.toThrow()
    // The exemptions are exactly the handlers that present the caller's token to ABS themselves.
    expect([...SELF_VALIDATING_OPERATIONS].sort()).toEqual([
      'getLibraryItem',
      'getLibraryItemCover',
      'listInProgressItems',
      'listLibraryItems',
      'startSession',
    ])
  })
})
