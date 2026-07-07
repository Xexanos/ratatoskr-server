import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AbsClient } from '../../abs/client.js'
import { InvalidCursorError } from '../../abs/cursor.js'
import { AbsAuthError, AbsNotFoundError } from '../../abs/errors.js'
import { bearerToken, MissingBearerError } from '../bearer.js'

// Mirrors the /library/items query parameters from the contract; Fastify validates,
// coerces, and applies the default limit at runtime.
const listQuerystring = {
  type: 'object',
  properties: {
    q: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    cursor: { type: 'string' },
  },
} as const

const itemParams = {
  type: 'object',
  required: ['itemId'],
  properties: { itemId: { type: 'string' } },
} as const

// SPEC section 2: a thin, per-user projection of the ABS library. These endpoints require
// the caller's bearer token, which is forwarded to ABS.
export async function registerLibraryRoutes(app: FastifyInstance, abs: AbsClient): Promise<void> {
  app.get(
    '/library/items',
    {
      schema: {
        querystring: listQuerystring,
        response: {
          200: { $ref: 'LibraryItemPage#' },
          400: { $ref: 'Error#' },
          401: { $ref: 'Error#' },
          502: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const { q: searchQuery, limit, cursor } = request.query as { q?: string; limit: number; cursor?: string }
      try {
        return await abs.listItems(bearerToken(request), { searchQuery, limit, cursor })
      } catch (err) {
        return libraryErrorReply(reply, err)
      }
    },
  )

  app.get(
    '/library/items/:itemId',
    {
      schema: {
        params: itemParams,
        response: {
          200: { $ref: 'LibraryItem#' },
          401: { $ref: 'Error#' },
          404: { $ref: 'Error#' },
          502: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string }
      try {
        return await abs.getItem(bearerToken(request), itemId)
      } catch (err) {
        return libraryErrorReply(reply, err)
      }
    },
  )
}

function libraryErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MissingBearerError || err instanceof AbsAuthError) {
    return reply.code(401).send({ code: 'unauthorized', message: 'A valid Audiobookshelf token is required' })
  }
  if (err instanceof InvalidCursorError) {
    return reply.code(400).send({ code: 'bad_request', message: 'Invalid pagination cursor' })
  }
  if (err instanceof AbsNotFoundError) {
    return reply.code(404).send({ code: 'not_found', message: 'No such library item' })
  }
  reply.log.error(err)
  return reply.code(502).send({ code: 'upstream_error', message: 'Audiobookshelf is unavailable' })
}
