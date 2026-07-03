import { readFileSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from '../config/index.js'
import { loadContractSchemas } from '../contract/schemas.js'
import { registerHealthRoute } from './routes/health.js'

// SPEC section 14: never log Authorization headers or query strings carrying a token.
// Request bodies are not logged by pino's default serializers at all, but /auth/*
// handlers must still take care not to log credentials explicitly. Left untyped (rather
// than importing Fastify's internal logger-options type) and checked structurally where
// it's passed to Fastify() below.
function loggerOptions() {
  return {
    redact: {
      paths: ['req.headers.authorization', 'req.query.token'],
      censor: '[redacted]',
    },
  }
}

export function buildApp(config: Config): FastifyInstance {
  // SPEC section 14: serve HTTPS whenever TLS is configured, so credentials and the
  // refresh token never cross the network in cleartext. loadConfig() already refuses to
  // run without TLS unless ALLOW_PLAIN_HTTP=true was set explicitly.
  //
  // Fastify's TypeScript overloads pick the server generic (http vs. https) from a
  // literal `https` option and don't unify into one return type across a runtime
  // conditional. We only use the common Fastify API surface here (routing, schemas,
  // listen/inject/close) which is identical either way, so the https branch is cast
  // back to the default FastifyInstance type.
  const app = config.tls
    ? (Fastify<HttpsServer>({
        logger: loggerOptions(),
        https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) },
      }) as unknown as FastifyInstance)
    : Fastify({ logger: loggerOptions() })

  for (const [name, schema] of Object.entries(loadContractSchemas(import.meta.url))) {
    app.addSchema({ $id: name, ...schema })
  }

  app.register(
    async (v1) => {
      await registerHealthRoute(v1, config)
    },
    { prefix: '/v1' },
  )

  return app
}
