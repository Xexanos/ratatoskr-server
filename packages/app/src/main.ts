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

  const app = await buildApp(config)
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
