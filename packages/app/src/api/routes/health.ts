import type { components } from '@ratatoskr/contract'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config/index.js'
import type { SonosClient } from '../../sonos/client.js'

type Health = components['schemas']['Health']
type DependencyStatus = components['schemas']['DependencyStatus']

const ABS_PING_TIMEOUT_MS = 2000

async function checkAbs(absUrl: string): Promise<DependencyStatus> {
  try {
    // Any HTTP response (even a 404) proves the host is reachable; we don't depend on
    // ABS exposing a specific health endpoint. Only a network-level failure means
    // "unreachable". The URL is not included in the detail (SPEC section 14: no upstream
    // URLs in responses/logs).
    const res = await fetch(absUrl, { method: 'GET', signal: AbortSignal.timeout(ABS_PING_TIMEOUT_MS) })
    // Discard the body so undici can return the connection to the pool instead of holding
    // the socket until GC — a /health poller would otherwise leak sockets.
    await res.body?.cancel()
    return { reachable: true }
  } catch {
    return { reachable: false, detail: 'Audiobookshelf did not respond' }
  }
}

// isReachable() is non-blocking: it reports the last known state and warms up discovery in the
// background, so this unauthenticated, frequently polled endpoint never waits on SSDP.
async function checkSonos(sonos: SonosClient): Promise<DependencyStatus> {
  return (await sonos.isReachable()) ? { reachable: true } : { reachable: false, detail: 'Sonos did not respond' }
}

export async function registerHealthRoute(
  app: FastifyInstance,
  config: Config,
  sonosClient: SonosClient,
): Promise<void> {
  app.get<{ Reply: Health }>(
    '/health',
    { schema: { response: { 200: { $ref: 'Health#' } } } },
    async () => {
      const [abs, sonos] = await Promise.all([checkAbs(config.absUrl), checkSonos(sonosClient)])
      // SPEC section 14: /health reports only coarse reachability — deliberately no
      // version and no URLs, since it is unauthenticated on an untrusted LAN.
      return {
        status: abs.reachable && sonos.reachable ? 'ok' : 'degraded',
        abs,
        sonos,
      }
    },
  )
}
