import { readFileSync } from 'node:fs'
import type { Server as HttpsServer } from 'node:https'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import openapiGlue from 'fastify-openapi-glue'
import { versionPrefix, type ContractDocument } from './apiPrefix.js'
import { AbsClient } from '../abs/client.js'
import { buildAbsDispatcher } from '../abs/transport.js'
import { AuthService } from '../auth/authService.js'
import { ChainKeepAlive } from '../auth/keepAlive.js'
import { SessionStore } from '../auth/sessionStore.js'
import type { Config } from '../config/index.js'
import { SessionManager } from '../playback/sessionManager.js'
import { SonosClient } from '../sonos/client.js'
import { mapError, NotImplementedError } from './errorHandler.js'
import { credentialPaths, enableCredentialRateLimit } from './rateLimit.js'
import { absBearerHandlers, ratatoskrBearerHandlers, type SecurityHandlers } from './security.js'
import type { ApiService } from './service.js'
import {
  createTokenGuard,
  SELF_VALIDATING_OPERATIONS,
  UNKNOWN_TOKEN_TOLERANT_OPERATIONS,
  type GuardOperation,
} from './tokenGuard.js'
import { V1ApiService } from './v1/service.js'
import { V2ApiService, type V2ApiServiceDeps } from './v2/service.js'

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
  // A store on a throwaway file, so a test does not write the configured one (test/helpers).
  sessionStore?: SessionStore
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
  // Opened here, as part of startup wiring, so a wrong key, an unreadable file or a directory that
  // cannot be written stops the boot rather than surfacing at some user's first sign-in — the store
  // creates its file when absent, which is what makes the last of those visible (SPEC section 8).
  // main.ts turns the resulting SessionStoreError into one actionable line.
  const store = options.sessionStore ?? (await SessionStore.open({ path: config.sessionStorePath, key: config.sessionStoreKey }))
  const auth = new AuthService(abs, store)
  // Armed as part of startup wiring, like the store it maintains: from here on every stored chain is
  // renewed daily, the ones that went stale while this server was down are renewed now, and the
  // request path renews an access token that has run out (SPEC section 8). Non-blocking — a slow or
  // unreachable Audiobookshelf may delay the first request, never the boot.
  const keepAlive = new ChainKeepAlive(abs, store, {
    refreshIntervalMs: config.keepAliveRefreshIntervalMs,
    logger: app.log,
  })
  keepAlive.start()
  // On shutdown, stop any active session (writes the final position back to ABS) before releasing
  // the Sonos subscription. Best-effort and optional-chained so injected Partial fakes are fine.
  app.addHook('onClose', async () => {
    keepAlive.stop()
    // Wait out a chain refresh caught mid-rotation before the process exits, so its store write is
    // not lost to process.exit (keepAlive.drained). Bounded by main.ts's drain timeout.
    await keepAlive.drained()
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

  const majors = servedMajors({ abs, sonos, sessions, auth }, keepAlive)
  // Before the mounts: the limit attaches as a per-route hook, so it has to be in place by the time
  // openapi-glue registers the routes it applies to (rateLimit.ts).
  await enableCredentialRateLimit(
    app,
    new Set(majors.flatMap((major) => credentialPaths(major.document, major.prefix))),
  )
  for (const major of majors) await mountMajor(app, major)

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
// (SPEC section 6). A major is added or dropped by editing this list alone; nothing downstream has to
// be revisited for it.
//
// Every entry is fully built before any of them is mounted, so a stale token-guard exemption fails
// startup rather than the first request that happens to hit that major (tokenGuard.ts). Order between
// the entries carries no meaning.
function servedMajors(deps: Omit<V2ApiServiceDeps, 'apiPrefix'>, keepAlive: ChainKeepAlive): ServedMajor[] {
  const v1Prefix = versionPrefix(frozenV1Document)
  const v2Prefix = versionPrefix(openapiDocument)

  return [
    {
      // Frozen at the contract-1.4.0 tag: the surface installed app versions talk to, which is why it
      // is served from its own document and its own service (v1/service.ts).
      document: frozenV1Document,
      prefix: v1Prefix,
      service: new V1ApiService({ ...deps, apiPrefix: v1Prefix }),
      // The bearer is an Audiobookshelf access token, and ABS is the sole authority on whether it is
      // still valid, so proving it costs an upstream call — skipped for the handlers that make one
      // anyway (SELF_VALIDATING_OPERATIONS).
      securityHandlers: absBearerHandlers,
      guardOperation: createTokenGuard(
        frozenV1Document,
        (request) => deps.abs.validateToken(request.absToken as string),
        SELF_VALIDATING_OPERATIONS,
      ),
    },
    {
      // The Ratatoskr-native surface (ADR-0001): the bearer is an opaque token this server issued, so
      // proving it is an in-process store lookup and no request path reaches ABS to authenticate.
      document: openapiDocument,
      prefix: v2Prefix,
      service: new V2ApiService({ ...deps, apiPrefix: v2Prefix }),
      securityHandlers: ratatoskrBearerHandlers,
      guardOperation: createTokenGuard(
        openapiDocument,
        resolveDeviceSession(deps.auth, keepAlive),
        UNKNOWN_TOKEN_TOLERANT_OPERATIONS,
      ),
    },
  ]
}

// /v2's `prove`: turn the caller's Ratatoskr token into the device session behind it, and put that
// session's Audiobookshelf access token where every shared handler already looks for one. That
// single assignment is what makes "upstream calls run on the session entry's chain" true for the
// whole surface at once (SPEC section 8), without any shared handler knowing which major it serves.
//
// The chain goes through the keep-alive loop on the way, so an access token that expired during a
// pause is renewed before the handler behind this uses it, and a chain that has died answers 401
// `UPSTREAM_SESSION_LOST` rather than letting the handler fail upstream as a generic 401.
//
// `absTokenSource` is the same lookup left behind as a function, for the one handler whose work
// outlives its request: a playback session reads it again on every write-back, so a chain renewed
// mid-playback reaches the running sync loop (security.ts). It re-resolves from the token rather
// than closing over this request's entry, because that entry is a snapshot — which is the whole
// problem it exists to solve.
function resolveDeviceSession(auth: AuthService, keepAlive: ChainKeepAlive): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const token = request.ratatoskrToken as string
    const currentAccessToken = async (): Promise<string> => (await keepAlive.usableChain(auth.resolve(token))).accessToken
    request.absTokenSource = currentAccessToken
    request.absToken = await currentAccessToken()
  }
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
    // method; an operation a major declares but does not implement gets a stub that throws
    // NotImplementedError → 404, rather than glue's default notImplemented stub → 500. Both majors
    // currently implement everything they declare, so no route reaches it — it stays because the
    // alternative for the next declared-but-unbuilt operation is a 500 that reads like a server fault.
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
