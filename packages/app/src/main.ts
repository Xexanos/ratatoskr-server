import { AbsClient } from './abs/client.js'
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
  // The media URLs handed to speakers carry a long-lived stream-only ABS API key (ABS_STREAMER_API_KEY,
  // SPEC section 14) — no login/token-refresh to do at startup, so nothing streamer-related here.
  const app = await buildApp(config, { absClient: abs })
  // Handle the listen rejection explicitly: on a bind failure (e.g. EADDRINUSE) Fastify
  // rejects and does not log it itself, so without this the process would die with a raw
  // unhandled rejection instead of the same clean, formatted exit the config path gives.
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  installShutdownHandlers(app, config.shutdownTimeoutMs)
}

// Graceful shutdown (SPEC section 5): on a termination signal, close the server — the onClose hook
// stops any active session, writing the reached position back to ABS — then exit. Bounded by a drain
// timeout so a hung final write can't wedge the process. The first signal wins (a second, arriving
// while draining, has no handler left and takes the default terminate). SIGTERM is what a container
// runtime sends on `docker stop`; SIGINT covers Ctrl-C in the foreground.
function installShutdownHandlers(app: Awaited<ReturnType<typeof buildApp>>, drainTimeoutMs: number): void {
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'received signal, shutting down')
    const drained = app.close().then(
      () => 'drained' as const,
      (err: unknown) => {
        app.log.error(err)
        return 'drained' as const
      },
    )
    const timedOut = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), drainTimeoutMs)
      timer.unref?.()
    })
    void Promise.race([drained, timedOut]).then((outcome) => {
      // A timed-out drain means the final write may be truncated — say so, so it isn't mistaken for
      // a clean stop (progress still survives via the periodic write-back, hence exit 0 either way).
      if (outcome === 'timeout') app.log.warn({ drainTimeoutMs }, 'shutdown drain timed out; exiting anyway')
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

void main()
