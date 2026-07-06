import { readFileSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import { contractSchemas } from '@ratatoskr/contract'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { AbsClient } from '../abs/client.js'
import type { Config } from '../config/index.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerHealthRoute } from './routes/health.js'

// SPEC section 14: tokens must never be logged. Pino's default request serializer logs
// the raw `req.url` including the query string, so a path-based redact of `req.query.token`
// is inert — a request like `?token=SECRET` would be logged verbatim. This custom
// serializer strips the query string entirely (and, by only emitting these fields, never
// logs the Authorization header either).
export function redactedReqSerializer(req: { method: string; url: string }): {
  method: string
  url: string
} {
  const queryStart = req.url.indexOf('?')
  return { method: req.method, url: queryStart === -1 ? req.url : req.url.slice(0, queryStart) }
}

function loggerOptions() {
  return { serializers: { req: redactedReqSerializer } }
}

export interface BuildAppOptions {
  // Dev/test only: assert responses actually conform to the contract schema (enum values,
  // shape). Fastify's route response schema only *serializes* (fast-json-stringify), it
  // does not *validate* — so enum violations and shape drift pass silently in production.
  // Enabling this in tests turns SPEC section 12's conformance promise into a real guard.
  validateResponses?: boolean
  // Inject a fake Audiobookshelf client in tests. Defaults to a real one built from config.
  absClient?: AbsClient
}

export async function buildApp(config: Config, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // SPEC section 14: serve HTTPS whenever TLS is configured, so credentials and the
  // refresh token never cross the network in cleartext. loadConfig() already validated
  // that the cert/key exist and are readable (or that ALLOW_PLAIN_HTTP was set), so these
  // reads won't surprise us with an ENOENT here.
  //
  // Fastify's TypeScript overloads pick the server generic (http vs. https) from a literal
  // `https` option and don't unify into one return type across a runtime conditional. We
  // only use the common Fastify API surface here (routing, schemas, listen/inject/close)
  // which is identical either way, so the https branch is cast back to FastifyInstance.
  const app = config.tls
    ? (Fastify<HttpsServer>({
        logger: loggerOptions(),
        https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) },
      }) as unknown as FastifyInstance)
    : Fastify({ logger: loggerOptions() })

  // The contract's component schemas (generated and $ref-rewritten at build time by
  // @ratatoskr/contract) are registered by $id so routes can reference them as "Name#".
  for (const [name, schema] of Object.entries(contractSchemas)) {
    app.addSchema({ $id: name, ...schema })
  }

  // Map every error into the contract's Error shape ({ code, message }) so responses stay
  // contract-conformant — Fastify's default validation/error body has a different shape.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ code: 'bad_request', message: error.message })
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ code: 'bad_request', message: error.message })
    }
    request.log.error(error)
    return reply.code(500).send({ code: 'internal_error', message: 'Internal server error' })
  })

  const abs = options.absClient ?? new AbsClient(config.absUrl)

  if (options.validateResponses) {
    // Queued before the routes so its onRoute hook sees them. The dynamic import only
    // loads the module (it doesn't touch Fastify), so registration order is preserved and
    // the dev-only dependencies stay out of the production code path.
    const { enableResponseValidation } = await import('./responseValidation.js')
    enableResponseValidation(app)
  }

  app.register(
    async (v1) => {
      await registerHealthRoute(v1, config)
      await registerAuthRoutes(v1, abs)
    },
    { prefix: '/v1' },
  )

  return app
}
