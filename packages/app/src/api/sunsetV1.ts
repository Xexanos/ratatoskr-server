import type { FastifyInstance } from 'fastify'

// The prefix of the sunset major. A constant rather than derived from a contract: /v1 has no contract
// document any more, which is the point - the route below is the whole of what is left of it.
const SUNSET_PREFIX = '/v1'

// The one response an installed app of the /v1 generation gets, indefinitely (SPEC section 6,
// ADR-0001). The code follows the machine-readable convention ADR-0001 set (UPSTREAM_SESSION_LOST);
// the message is what a person may end up reading.
const UPGRADE_REQUIRED = {
  code: 'UPGRADE_REQUIRED',
  message: 'This version of the API has been retired. Please update the app.',
} as const

// Answers every route under /v1 - any method, any path, any body - with 410 Gone.
//
// Unauthenticated on purpose: the old app has to be able to surface this even with no valid token,
// and it can only do so if nothing in front of the answer asks for one. So this is a plain route,
// outside the contract, the security handlers and the token guard, and it never reaches Audiobookshelf.
//
// The answer is sent from an `onRequest` hook, which runs before Fastify reads or parses the body: a
// malformed, oversized or unexpectedly typed one (400, 413, 415) must not turn the answer into anything
// else. The route below exists only so that the hook has something to match.
//
// Not rate limited: the limit is an allow-list over the credential routes (rateLimit.ts), and an
// unauthenticated 410 takes no credential and costs nothing to serve.
export async function registerSunsetV1(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onRequest', (_request, reply) => reply.code(410).send(UPGRADE_REQUIRED))
    // Both spellings: the wildcard route does not match the bare prefix.
    scope.all(SUNSET_PREFIX, () => undefined)
    scope.all(`${SUNSET_PREFIX}/*`, () => undefined)
  })
}
