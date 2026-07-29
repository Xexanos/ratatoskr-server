import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ContractDocument } from './apiPrefix.js'
import { TooManyRequestsError } from './errorHandler.js'

// SPEC section 14: the endpoints that take credentials get a conservative per-source-address limit,
// so Ratatoskr is not a free brute-force funnel in front of Audiobookshelf. Without one, an attacker
// on the LAN can try passwords against ABS as fast as this server will proxy them, and ABS never sees
// the source address to throttle it itself.
//
// The other unauthenticated endpoints stay unlimited on purpose: /health and the speaker list take no
// credentials, serve cached local state, and are polled legitimately — a limit there would turn a
// monitoring loop into an outage.

// Operations whose request body carries a credential. Named by operationId rather than by path, so
// the limit follows the operation wherever a major mounts it.
export const CREDENTIAL_OPERATIONS: ReadonlySet<string> = new Set([
  'login', // username and password
  'refresh', // a refresh token, which is a credential in its own right
])

// Conservative in the sense SPEC section 14 asks for: far above what a person mistyping a password
// reaches, far below what makes an online guessing attack worthwhile. Deliberately not configurable —
// there is no operational question a knob would answer that changing this constant would not.
export const CREDENTIAL_ATTEMPTS_PER_WINDOW = 10
export const CREDENTIAL_WINDOW = '1 minute'

// The concrete route paths to limit for one served major: its credential operations, under its own
// mount prefix. Derived from the document so the set cannot drift from what is actually served — and
// so a major that does not declare an operation simply has no route for it.
export function credentialPaths(document: ContractDocument, prefix: string): string[] {
  const paths = (document['paths'] ?? {}) as Record<string, Record<string, unknown>>
  const limited: string[] = []
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (typeof operation !== 'object' || operation === null) continue
      const { operationId } = operation as { operationId?: string }
      if (operationId !== undefined && CREDENTIAL_OPERATIONS.has(operationId)) limited.push(`${prefix}${path}`)
    }
  }
  return limited
}

// Registers the limit. Must run before the routes are mounted, since the plugin attaches its check as
// a per-route hook.
//
// `allowList` is the lever rather than per-route config, and it reads inverted for a reason: it exempts
// everything whose matched route is not in the limited set. Per-route config would mean mutating the
// route options openapi-glue produces from an onRoute hook, and getting that right depends on this
// module's hook running before the plugin's — a fragile ordering to rest a security control on. One
// predicate over a set of paths has no such dependency.
//
// An unrouted request has no matched route and so is exempt: it reaches no credential handler, and
// counting it would let a stranger exhaust a real client's window by spraying unknown paths.
//
// One registration means one budget per address across all the limited routes, rather than one budget
// each. That is the stronger reading and the intended one: the allowance is for credential attempts as
// such, so alternating between login, refresh, and another major's login buys no extra tries.
export async function enableCredentialRateLimit(app: FastifyInstance, limited: ReadonlySet<string>): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: CREDENTIAL_ATTEMPTS_PER_WINDOW,
    timeWindow: CREDENTIAL_WINDOW,
    allowList: (request: FastifyRequest) => {
      const routePath = request.routeOptions?.url
      return routePath === undefined || !limited.has(routePath)
    },
    // What this returns is handed to the error handler, not sent as-is, so it returns the domain error
    // and lets the one place that maps thrown values to responses shape the body (errorHandler.ts).
    // Returning a ready-made body here would give this refusal alone a shape unlike every other error
    // this API answers with.
    errorResponseBuilder: () => new TooManyRequestsError(),
  })
}
