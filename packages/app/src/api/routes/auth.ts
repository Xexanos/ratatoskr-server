import type { components } from '@ratatoskr/contract'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AbsClient } from '../../abs/client.js'
import { AbsAuthError } from '../../abs/errors.js'

type LoginRequest = components['schemas']['LoginRequest']
type RefreshRequest = components['schemas']['RefreshRequest']

const errorResponses = {
  400: { $ref: 'Error#' },
  401: { $ref: 'Error#' },
  502: { $ref: 'Error#' },
}

// The request body is validated at runtime against the referenced JSON schema before the
// handler runs, so casting request.body to the contract type reflects the guaranteed
// shape. (Fastify v5's generic body inference doesn't hold up under our setup/TS version,
// so we cast rather than rely on it.)
export async function registerAuthRoutes(app: FastifyInstance, abs: AbsClient): Promise<void> {
  app.post(
    '/auth/login',
    { schema: { body: { $ref: 'LoginRequest#' }, response: { 200: { $ref: 'AuthTokens#' }, ...errorResponses } } },
    async (request, reply) => {
      const { username, password } = request.body as LoginRequest
      try {
        return await abs.login(username, password)
      } catch (err) {
        return absErrorReply(reply, err)
      }
    },
  )

  app.post(
    '/auth/refresh',
    { schema: { body: { $ref: 'RefreshRequest#' }, response: { 200: { $ref: 'AuthTokens#' }, ...errorResponses } } },
    async (request, reply) => {
      const { refreshToken } = request.body as RefreshRequest
      try {
        return await abs.refresh(refreshToken)
      } catch (err) {
        return absErrorReply(reply, err)
      }
    },
  )
}

function absErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AbsAuthError) {
    return reply.code(401).send({ code: 'unauthorized', message: 'Invalid Audiobookshelf credentials' })
  }
  // AbsUpstreamError and anything unexpected: the dependency failed.
  reply.log.error(err)
  return reply.code(502).send({ code: 'upstream_error', message: 'Audiobookshelf is unavailable' })
}
