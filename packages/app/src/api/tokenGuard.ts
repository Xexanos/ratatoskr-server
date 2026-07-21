import type { FastifyReply, FastifyRequest } from 'fastify'

// The invariant this module enforces: every bearer-protected operation proves the caller's
// token against ABS before acting. The bearerAuth security handler checks for presence only
// (SPEC section 8 — ABS is the sole authority on validity), so an operation whose handler
// never presents the token to ABS would otherwise act for any non-empty bearer on the
// untrusted LAN (SPEC section 14).
//
// Operations prove the token one of two ways:
//   - self-validating: the handler forwards the caller's token to ABS as part of its real
//     work, so an invalid token 401s upstream (listed below, one justification each);
//   - guarded: everything else gets `validate` (AbsClient.validateToken) run before its
//     handler, wired in buildApp's operationResolver.
// A new contract operation is guarded by default — forgetting this module fails closed.

type OperationHandler = (request: FastifyRequest, reply: FastifyReply) => unknown

// The operations whose handlers present the caller's token to ABS themselves. An entry must
// name a bearer-protected operationId in the contract — createTokenGuard throws at startup
// otherwise, so a renamed or re-secured operation cannot leave a stale exemption behind.
export const SELF_VALIDATING_OPERATIONS: ReadonlySet<string> = new Set([
  'listLibraryItems', // forwards the token via abs.listItems
  'getLibraryItem', // forwards the token via abs.getItem
  'getLibraryItemCover', // forwards the token via abs.getItemCover
  'listInProgressItems', // forwards the token via abs.listInProgressItems
  'startSession', // presents the token via abs.getPlaybackManifest/getProgress before touching state
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

function bearerProtectedOperationIds(document: Record<string, unknown>): Set<string> {
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
// bearer-protected and not self-validating → the handler is prefixed with `validate`;
// anything else passes through untouched (identity, so there is no wrapper to reason about).
export function createTokenGuard(
  document: Record<string, unknown>,
  validate: (token: string) => Promise<void>,
  selfValidating: ReadonlySet<string> = SELF_VALIDATING_OPERATIONS,
): (operationId: string, handler: OperationHandler) => OperationHandler {
  const protectedIds = bearerProtectedOperationIds(document)
  for (const operationId of selfValidating) {
    if (!protectedIds.has(operationId)) {
      throw new Error(
        `tokenGuard: self-validating entry "${operationId}" is not a bearer-protected operation in the contract — remove or fix the stale exemption`,
      )
    }
  }
  return (operationId, handler) => {
    if (!protectedIds.has(operationId) || selfValidating.has(operationId)) return handler
    return async (request, reply) => {
      // absToken was stashed by the bearerAuth security handler, which glue runs before any
      // protected operation's handler (security.ts).
      await validate(request.absToken as string)
      return handler(request, reply)
    }
  }
}
