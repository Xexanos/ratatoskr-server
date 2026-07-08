import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SonosClient } from '../../sonos/client.js'
import { bearerToken, MissingBearerError } from '../bearer.js'

// SPEC section 2/3: list the Sonos speakers and groups discovered on the LAN. A bearer token
// is required (contract's global security), but it is not forwarded — Sonos discovery is a
// local UPnP operation, not an upstream call scoped to the user.
export async function registerSpeakerRoutes(app: FastifyInstance, sonos: SonosClient): Promise<void> {
  app.get(
    '/speakers',
    {
      schema: {
        response: {
          200: { type: 'array', items: { $ref: 'Speaker#' } },
          401: { $ref: 'Error#' },
          502: { $ref: 'Error#' },
        },
      },
    },
    async (request, reply) => {
      try {
        bearerToken(request) // presence check only; not forwarded to Sonos
        return await sonos.listSpeakers()
      } catch (err) {
        return speakerErrorReply(reply, err)
      }
    },
  )
}

function speakerErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MissingBearerError) {
    return reply.code(401).send({ code: 'unauthorized', message: 'A valid Audiobookshelf token is required' })
  }
  // SonosUpstreamError and anything unexpected: the dependency failed.
  reply.log.error(err)
  return reply.code(502).send({ code: 'upstream_error', message: 'Sonos is unavailable' })
}
