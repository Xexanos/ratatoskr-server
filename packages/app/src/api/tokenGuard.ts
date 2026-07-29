import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ContractDocument } from './apiPrefix.js'

// The invariant this module enforces: every bearer-protected operation proves the caller's bearer
// before acting. The bearerAuth security handler checks for presence only, so an operation whose
// handler never proves it would otherwise act for any non-empty bearer on the untrusted LAN (SPEC
// section 14).
//
// What *proving* means is the major's business, not this module's — each mount passes its own
// `prove` (app.ts). Under /v1 the bearer is an Audiobookshelf access token and proving it is an
// upstream call; under /v2 it is a Ratatoskr token and proving it is an in-process store lookup
// that also resolves the chain the handler then acts on (SPEC section 8). This module only decides
// *which* operations must be proved, and that answer comes from the contract — so a new operation
// is guarded by default and forgetting this module fails closed.
//
// Two kinds of operation are exempt, each named in a list with one justification per entry:
// self-validating (the handler proves the bearer itself, as part of its real work) and
// unknown-token-tolerant (the operation is defined to answer normally for a bearer that names no
// session). Both are checked against the contract at startup, so a stale exemption cannot survive
// a rename.

export type OperationHandler = (request: FastifyRequest, reply: FastifyReply) => unknown

// What createTokenGuard returns: the wrap applied to every one of a major's handlers (app.ts).
export type GuardOperation = (operationId: string, handler: OperationHandler) => OperationHandler

// The operations whose handlers present the caller's token to ABS themselves. An entry must
// name a bearer-protected operationId in the contract — createTokenGuard throws at startup
// otherwise, so a renamed or re-secured operation cannot leave a stale exemption behind.
//
// Shared by every served major, so an entry has to hold for all of them: one naming an operation that
// only some declare fails the others' startup check and takes the whole process down with it, and a
// frozen document cannot gain an operationId to resolve that. Pass a major-specific exemption as
// createTokenGuard's third argument instead; it must never be added here.
export const SELF_VALIDATING_OPERATIONS: ReadonlySet<string> = new Set([
  'listLibraryItems', // forwards the token via abs.listItems
  'getLibraryItem', // forwards the token via abs.getItem
  'getLibraryItemCover', // forwards the token via abs.getItemCover
  'listInProgressItems', // forwards the token via abs.listInProgressItems
  'startSession', // presents the token via abs.getPlaybackManifest/getProgress before touching state
])

// The /v2 exemptions, and the reason that surface cannot reuse the list above: under 2.0.0 no
// handler forwards the caller's bearer upstream — it is a Ratatoskr token, meaningless to
// Audiobookshelf — so nothing is self-validating there, and every operation needs the resolved
// session anyway. What is left is the one operation defined to succeed for a bearer this server
// does not know: sign-out is idempotent by contract, so that a client can always complete a
// sign-out locally. Its handler is what tolerates the unknown token, hence no guard.
export const UNKNOWN_TOKEN_TOLERANT_OPERATIONS: ReadonlySet<string> = new Set([
  'logout', // the contract makes it idempotent: an unknown or already-revoked token still answers 204
])

// Walk the contract for the operationIds that carry a bearer requirement: the global
// `security` applies unless an operation overrides it (`security: []` opts out — getHealth,
// login, refresh, listSpeakers).
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
// — and what proving it leaves behind for the handler — differs per major. It runs after the
// security handler, which glue runs before any protected operation's handler (security.ts), so
// whatever that stashed on the request is available here.
//
// `exempt` has no default on purpose. A default would be one major's list silently applied to
// another, and the failure is silent in the worst direction: an operation wrongly exempted is not
// rejected, it runs unproven — on /v2 that means its handler acts with no resolved chain at all.
// Every mount states its own set, and the startup check below only catches entries that name no
// bearer-protected operation, not entries that belong to the other major.
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
