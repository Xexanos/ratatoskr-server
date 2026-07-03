import { buildApp } from './api/app.js'
import { ConfigError, loadConfig } from './config/index.js'

function main(): void {
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

  const app = buildApp(config)
  void app.listen({ port: config.port, host: '0.0.0.0' })
}

main()
