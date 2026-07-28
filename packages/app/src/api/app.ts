import { readFileSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import Fastify, { type FastifyInstance } from 'fastify'
import openapiGlue from 'fastify-openapi-glue'
import { versionPrefix } from '../apiPrefix.js'
import { AbsClient } from '../abs/client.js'
import { buildAbsDispatcher } from '../abs/transport.js'
import type { Config } from '../config/index.js'
import { SessionManager } from '../playback/sessionManager.js'
import { SonosClient } from '../sonos/client.js'
import { mapError, NotImplementedError } from './errorHandler.js'
import { securityHandlers, type SecurityHandlers } from './security.js'
import { ApiService, type ApiServiceDeps } from './service.js'
import { createTokenGuard, type GuardOperation } from './tokenGuard.js'
import { V1ApiService } from './v1/service.js'

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

// Tests inject fakes for any of these; each defaults to a real one built from config.
export interface BuildAppOptions {
  absClient?: AbsClient
  sonosClient?: SonosClient
  sessionManager?: SessionManager
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

  // Map every error into the contract's Error shape ({ code, message }) so responses stay
  // contract-conformant. All domain-error → HTTP mapping lives in mapError (errorHandler.ts).
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error)
    if (mapped.statusCode >= 500) request.log.error(error)
    return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message })
  })

  // Unknown paths go to Fastify's not-found handler, not setErrorHandler — shape that response
  // as the contract's Error ({ code, message }) too, instead of Fastify's default body.
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ code: 'not_found', message: 'Not found' })
  })

  const abs =
    options.absClient ?? new AbsClient(config.absUrl, buildAbsDispatcher(config), config.absRequestTimeoutMs, app.log)
  const sonos = options.sonosClient ?? new SonosClient(config.sonosSeedHost, undefined, config.sonosRequestTimeoutMs)
  const sessions = options.sessionManager ?? new SessionManager({ abs, sonos, config })
  // On shutdown, stop any active session (writes the final position back to ABS) before releasing
  // the Sonos subscription. Best-effort and optional-chained so injected Partial fakes are fine.
  app.addHook('onClose', async () => {
    try {
      if (sessions.hasSession?.()) await sessions.stop()
    } catch {
      // best effort — do not block shutdown on a failed final write
    }
    await sonos.close?.()
  })

  if (config.validateResponses) {
    // Registered before the routes so its onRoute hook sees the ones openapi-glue adds. The
    // dynamic import keeps the dev-only ajv/plugin out of the production code path.
    const { enableResponseValidation } = await import('./responseValidation.js')
    enableResponseValidation(app)
  }

  // Both served majors, each mounted from its own contract (SPEC section 6). /v1 is contract 1.4.0
  // frozen at the contract-1.4.0 tag, kept alive for installed app versions until the sunset in
  // ADR-0001; /v2 is the contract under development.
  for (const major of servedMajors({ abs, sonos, sessions })) {
    await mountMajor(app, major)
  }

  return app
}

// One served major: its contract document plus everything version-specific behind it. Assembling the
// list is the only place that knows two majors exist — mountMajor treats them identically, so nothing
// downstream has to branch on a version, and dropping /v1 at sunset is dropping one entry.
interface ServedMajor {
  document: Record<string, unknown>
  // The object glue resolves operationIds against, one method per operation of *this* document.
  service: object
  // Per major on purpose: the two auth models must not reach each other's surface. /v1 proves the
  // caller's token against Audiobookshelf on every request (the shared-token model its contract
  // describes), while /v2 is to move to the in-process hash lookup over the session store as its
  // login lands (#134) — at which point only this entry changes.
  securityHandlers: SecurityHandlers
  guardOperation: GuardOperation
}

function servedMajors(deps: Omit<ApiServiceDeps, 'apiPrefix'>): ServedMajor[] {
  // Every bearer-protected operation proves the caller's token against ABS before acting — either its
  // handler forwards the token itself (self-validating), or the guard runs validateToken first.
  // Derived from the major's own document, so a new operation is guarded by default and a stale
  // exemption throws at startup (tokenGuard.ts).
  const absTokenGuard = (document: Record<string, unknown>) =>
    createTokenGuard(document, (token) => deps.abs.validateToken(token))

  return [
    {
      document: frozenV1Document,
      service: new V1ApiService({ ...deps, apiPrefix: versionPrefix(frozenV1Document) }),
      securityHandlers,
      guardOperation: absTokenGuard(frozenV1Document),
    },
    {
      document: openapiDocument,
      service: new ApiService({ ...deps, apiPrefix: versionPrefix(openapiDocument) }),
      securityHandlers,
      guardOperation: absTokenGuard(openapiDocument),
    },
  ]
}

// Routes, request/response schemas and per-operation auth are all derived from the major's contract
// (SPEC section 12): glue maps each operationId to a service method and runs the matching
// securityHandler as a preHandler. Mounted under the prefix that contract itself declares, which its
// paths omit (apiPrefix.ts). Each register() is its own Fastify plugin scope, so the schemas and
// preHandlers of one major stay out of the other's routes.
async function mountMajor(app: FastifyInstance, major: ServedMajor): Promise<void> {
  const methods = major.service as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
  await app.register(openapiGlue, {
    specification: major.document,
    // glue registers every path of this document. Resolve each operationId to the major's service
    // method; operations without one get a stub that throws NotImplementedError → 404, rather than
    // glue's default notImplemented stub → 500.
    operationResolver: (operationId: string) => {
      const method = methods[operationId]
      return typeof method === 'function'
        ? major.guardOperation(operationId, method.bind(major.service))
        : () => {
            throw new NotImplementedError()
          }
    },
    securityHandlers: major.securityHandlers,
    prefix: versionPrefix(major.document),
  })
}
