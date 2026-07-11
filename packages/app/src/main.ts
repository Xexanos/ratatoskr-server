import { AbsClient } from './abs/client.js'
import { StreamerSession } from './abs/streamerSession.js'
import { buildAbsDispatcher } from './abs/transport.js'
import { buildApp } from './api/app.js'
import { ConfigError, loadConfig } from './config/index.js'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  // Soft startup check: confirm ABS_URL points at a genuine Audiobookshelf server. A host that
  // answers but is not ABS is almost always a misconfiguration — fail loud now rather than
  // leaking it into runtime errors. A network error (ABS merely down/not up yet) must NOT block
  // startup: the server degrades gracefully and /health reports it. The probed client is reused.
  const abs = new AbsClient(config.absUrl, buildAbsDispatcher(config))
  const absStatus = await abs.probe()
  if (absStatus === 'not-audiobookshelf') {
    console.error(
      'ABS_URL responded but does not look like an Audiobookshelf server (GET /ping did not ' +
        'return {"success":true}). Check ABS_URL. Refusing to start.',
    )
    process.exit(1)
  }
  if (absStatus === 'unreachable') {
    console.warn('Audiobookshelf did not respond at startup; continuing (see /v1/health).')
  }

  // Log the dedicated streamer identity in at startup (SPEC section 8) so its short-lived token is
  // ready for the media URLs handed to speakers. Best-effort like the ABS probe: if ABS is not up
  // yet (or the token has to be refreshed later), the session manager re-logs in on first playback,
  // so a transient failure here must not block startup.
  const streamer = new StreamerSession(abs, config.absStreamerUser, config.absStreamerPassword)
  try {
    await streamer.login()
  } catch {
    console.warn('Streamer login failed at startup; will retry on first playback (see SPEC section 14).')
  }

  const app = await buildApp(config, { absClient: abs, streamer })
  // Handle the listen rejection explicitly: on a bind failure (e.g. EADDRINUSE) Fastify
  // rejects and does not log it itself, so without this the process would die with a raw
  // unhandled rejection instead of the same clean, formatted exit the config path gives.
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

void main()
