import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ContractDocument } from './apiPrefix.js'

// The invariant this module enforces: every bearer-protected operation proves the caller's bearer
// before acting. The bearerAuth security handler checks for presence only, so an operation whose
// handler never proves it would otherwise act for any non-empty bearer on the untrusted LAN (SPEC
// section 14).
//
// What *proving* means is the mount's business, not this module's — it passes its own `prove`
// (app.ts): the bearer is a Ratatoskr token and proving it is an in-process store lookup that also
// resolves the chain the handler then acts on (SPEC section 8). This module only decides *which*
// operations must be proved, and that answer comes from the contract — so a new operation is guarded
// by default and forgetting this module fails closed.
//
// An operation may be exempt when it is defined to answer normally for a bearer that names no session
// (unknown-token-tolerant), named in a list with one justification per entry. The list is checked
// against the contract at startup, so a stale exemption cannot survive a rename.

export type OperationHandler = (request: FastifyRequest, reply: FastifyReply) => unknown

// What createTokenGuard returns: the wrap applied to every one of a major's handlers (app.ts).
export type GuardOperation = (operationId: string, handler: OperationHandler) => OperationHandler

// The exemptions. No handler forwards the caller's bearer upstream — it is a Ratatoskr token,
// meaningless to Audiobookshelf — so nothing is self-validating, and every operation needs the
// resolved session anyway. What is left is the one operation defined to succeed for a bearer this
// server does not know: sign-out is idempotent by contract, so that a client can always complete a
// sign-out locally. Its handler is what tolerates the unknown token, hence no guard.
export const UNKNOWN_TOKEN_TOLERANT_OPERATIONS: ReadonlySet<string> = new Set([
  'logout', // the contract makes it idempotent: an unknown or already-revoked token still answers 204
])

// Walk the contract for the operationIds that carry a bearer requirement: the global
// `security` applies unless an operation overrides it (`security: []` opts out — getHealth,
// login, listSpeakers).
//
// Only requirements naming this scheme count: the guard reads request.absToken, which the
// bearerAuth security handler alone sets (security.ts), so an operation secured by any other
// scheme must not land in the guarded set — a bearer check against a missing absToken would
// reject it unconditionally.
const BEARER_SCHEME = 'bearerAuth'

function bearerProtectedOperationIds(document: ContractDocument): Set<string> {
  const globalSecurity = Array.isArray(document['security']) ? (document['security'] as unknown[]) : []
  const ids = new Set<string>()
  const paths = (document['paths'] ?? {}) as Record<string, Record<string, unknown>>
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (typeof operation !== 'object' || operation === null) continue
      const { operationId, security } = operation as { operationId?: string; security?: unknown[] }
      if (operationId === undefined) continue
      if (requiresBearer(security ?? globalSecurity)) ids.add(operationId)
    }
  }
  return ids
}

// A security requirement object is keyed by scheme name (OpenAPI 3), so bearer protection
// means some requirement carries the bearer scheme's key — an operation secured only by
// some other scheme is not this guard's business.
function requiresBearer(requirements: unknown[]): boolean {
  return requirements.some(
    (requirement) => typeof requirement === 'object' && requirement !== null && BEARER_SCHEME in requirement,
  )
}

// Returns the wrap function buildApp's operationResolver runs every handler through:
// bearer-protected and not exempt → the handler is prefixed with `prove`; anything else passes
// through untouched (identity, so there is no wrapper to reason about).
//
// `prove` receives the request rather than a token, because what a bearer has to be proved against
// — and what proving it leaves behind for the handler — differs per mount. It runs after the
// security handler, which glue runs before any protected operation's handler (security.ts), so
// whatever that stashed on the request is available here.
//
// `exempt` has no default on purpose. A default would be a list silently applied to a mount it was not
// written for, and the failure is silent in the worst direction: an operation wrongly exempted is not
// rejected, it runs unproven — its handler acts with no resolved chain at all. Every mount states its
// own set, and the startup check below only catches entries that name no bearer-protected operation.
export function createTokenGuard(
  document: ContractDocument,
  prove: (request: FastifyRequest) => Promise<void> | void,
  exempt: ReadonlySet<string>,
): GuardOperation {
  const protectedIds = bearerProtectedOperationIds(document)
  for (const operationId of exempt) {
    if (!protectedIds.has(operationId)) {
      throw new Error(
        `tokenGuard: exempt entry "${operationId}" is not a bearer-protected operation in the contract — remove or fix the stale exemption`,
      )
    }
  }
  return (operationId, handler) => {
    if (!protectedIds.has(operationId) || exempt.has(operationId)) return handler
    return async (request, reply) => {
      await prove(request)
      return handler(request, reply)
    }
  }
}
