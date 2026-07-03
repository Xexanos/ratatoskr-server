import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config/index.js'
import type { components } from '../../contract/generated/openapi.js'
import pkg from '../../../package.json' with { type: 'json' }

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']

const ABS_PING_TIMEOUT_MS = 2000

async function checkAbs(absUrl: string): Promise<DependencyStatus> {
  try {
    // Any HTTP response (even a 404) proves the host is reachable; we don't depend on
    // ABS exposing a specific health endpoint. Only a network-level failure means
    // "unreachable". The URL itself is not included in the detail (SPEC section 14:
    // don't put upstream URLs in responses/logs).
    await fetch(absUrl, { method: 'GET', signal: AbortSignal.timeout(ABS_PING_TIMEOUT_MS) })
    return { reachable: true }
  } catch {
    return { reachable: false, detail: 'Audiobookshelf did not respond' }
  }
}

// TODO(phase 4): once the Sonos client exists, check real reachability and factor it
// into the overall `status` below instead of always reporting unimplemented.
function checkSonos(): DependencyStatus {
  return { reachable: false, detail: 'Sonos control is not implemented yet (planned for phase 4)' }
}

export async function registerHealthRoute(app: FastifyInstance, config: Config): Promise<void> {
  app.get<{ Reply: Health }>(
    '/health',
    { schema: { response: { 200: { $ref: 'Health#' } } } },
    async () => {
      const [abs, sonos] = await Promise.all([checkAbs(config.absUrl), Promise.resolve(checkSonos())])
      return {
        status: abs.reachable ? 'ok' : 'degraded',
        version: pkg.version,
        abs,
        sonos,
      }
    },
  )
}
