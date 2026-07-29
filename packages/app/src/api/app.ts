import { readFileSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import Fastify, { type FastifyInstance } from 'fastify'
import openapiGlue from 'fastify-openapi-glue'
import { versionPrefix, type ContractDocument } from './apiPrefix.js'
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

  for (const major of servedMajors({ abs, sonos, sessions })) await mountMajor(app, major)

  return app
}

// One served major: its contract document and everything derived from it. Nothing outside this file
// branches on a version — a request is answered by whichever mount it arrived on, with that mount's
// own service, guard, and security-handler set.
//
// `prefix` is derived once, here, and used for both the Fastify mount and the service that mints
// URLs under it. Deriving it twice from the same document would give the same answer today, which is
// exactly the problem: the guarantee that a major's routes and its URLs cannot drift apart should be
// structural, not two independent calls happening to agree.
interface ServedMajor {
  document: ContractDocument
  prefix: string
  service: ApiService
  securityHandlers: SecurityHandlers
  guardOperation: GuardOperation
}

// The list of majors served side by side, and the only place that knows there is more than one
// (SPEC section 6). Two are served for the transition window ADR-0001 sets out; sunsetting /v1 (#137)
// is removing its entry, and nothing downstream has to be revisited for that.
//
// Every entry is fully built before any of them is mounted, so a stale token-guard exemption fails
// startup rather than the first request that happens to hit that major (tokenGuard.ts). Order between
// the entries carries no meaning.
function servedMajors(deps: Omit<ApiServiceDeps, 'apiPrefix'>): ServedMajor[] {
  // Every bearer-protected operation proves the caller's token against ABS before acting — either
  // its handler forwards the token itself (self-validating), or the guard runs validateToken first.
  // Derived per document, so an operation only one major has is still guarded by default.
  const absTokenGuard = (document: ContractDocument): GuardOperation =>
    createTokenGuard(document, (token) => deps.abs.validateToken(token))

  const v1Prefix = versionPrefix(frozenV1Document)
  const v2Prefix = versionPrefix(openapiDocument)

  return [
    {
      // Contract 1.4.0, frozen at the contract-1.4.0 tag: what installed app versions talk to. Its
      // service adds back the operations 2.0.0 dropped (v1/service.ts).
      document: frozenV1Document,
      prefix: v1Prefix,
      service: new V1ApiService({ ...deps, apiPrefix: v1Prefix }),
      securityHandlers,
      guardOperation: absTokenGuard(frozenV1Document),
    },
    {
      // The contract under development. Its bearer is still an Audiobookshelf access token; #134
      // replaces that with an opaque Ratatoskr one, which is a change to this entry's guard and
      // service — the seam exists so it can be made without touching /v1's. Both majors share one
      // securityHandlers object today because the scheme name and the presence check are the same;
      // the field is per-major so #134 can give /v2 its own without touching /v1's.
      document: openapiDocument,
      prefix: v2Prefix,
      service: new ApiService({ ...deps, apiPrefix: v2Prefix }),
      securityHandlers,
      guardOperation: absTokenGuard(openapiDocument),
    },
  ]
}

// Registers one openapi-glue instance for a major: routes, request/response schemas and
// per-operation auth all derived from its document (SPEC section 12). glue maps each operationId to
// the matching service method and runs the matching securityHandler as a preHandler.
//
// The mount prefix is the one the major's own service was given, so a major's routes and the URLs its
// responses carry are resolvable against each other by construction (apiPrefix.ts).
async function mountMajor(app: FastifyInstance, major: ServedMajor): Promise<void> {
  // glue resolves operationIds to methods by name, which no type can express — hence the index cast.
  const methods = major.service as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
  await app.register(openapiGlue, {
    specification: major.document,
    // glue registers every path the document declares. Resolve each operationId to its service
    // method; operations this major declares but does not implement get a stub that throws
    // NotImplementedError → 404, rather than glue's default notImplemented stub → 500. That is how
    // /v2's login and logout answer until #134 wires them to the session store — deliberately not
    // by inheriting /v1's Audiobookshelf proxies (v1/service.ts).
    operationResolver: (operationId) => {
      const method = methods[operationId]
      return typeof method === 'function'
        ? major.guardOperation(operationId, method.bind(major.service))
        : () => {
            throw new NotImplementedError()
          }
    },
    securityHandlers: major.securityHandlers,
    prefix: major.prefix,
  })
}
