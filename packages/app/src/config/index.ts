import { ConfigError } from './errors.js'

export interface TlsConfig {
  certPath: string
  keyPath: string
}

export interface Config {
  absUrl: string
  absStreamerUser: string
  absStreamerPassword: string
  sonosSeedHost: string | undefined
  port: number
  pollIntervalSeconds: number
  seekSettleMs: number
  seekToleranceSeconds: number
  seekRetries: number
  progressWriteThresholdSeconds: number
  tls: TlsConfig | undefined
}

type Env = Record<string, string | undefined>

// Validation deliberately aggregates every problem and throws a single ConfigError at
// the end, instead of failing fast on the first missing variable — one restart cycle to
// see everything that's wrong, not one per variable.
class EnvReader {
  private readonly problems: string[] = []

  constructor(private readonly env: Env) {}

  requireString(name: string): string {
    const value = this.env[name]
    if (value === undefined || value.trim() === '') {
      this.problems.push(`${name} is required`)
      return ''
    }
    return value
  }

  positiveNumber(name: string, fallback: number): number {
    const raw = this.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      this.problems.push(`${name} must be a positive number (got "${raw}")`)
      return fallback
    }
    return value
  }

  port(): number {
    const value = this.positiveNumber('PORT', 8080)
    if (!Number.isInteger(value) || value > 65535) {
      this.problems.push(`PORT must be an integer between 1 and 65535 (got "${this.env.PORT}")`)
      return 8080
    }
    return value
  }

  tls(): TlsConfig | undefined {
    const certPath = this.env.TLS_CERT_PATH
    const keyPath = this.env.TLS_KEY_PATH
    const allowPlainHttp = this.env.ALLOW_PLAIN_HTTP === 'true'

    if (certPath && keyPath) return { certPath, keyPath }
    if (certPath || keyPath) {
      this.problems.push('TLS_CERT_PATH and TLS_KEY_PATH must both be set, or neither')
      return undefined
    }
    if (!allowPlainHttp) {
      this.problems.push(
        'no TLS configured (TLS_CERT_PATH/TLS_KEY_PATH). Credentials and refresh tokens must ' +
          'not cross the network in cleartext (SPEC section 14). Configure TLS, or set ' +
          'ALLOW_PLAIN_HTTP=true to explicitly accept the risk (e.g. TLS is terminated by a ' +
          'reverse proxy).',
      )
    }
    return undefined
  }

  throwIfInvalid(): void {
    if (this.problems.length > 0) throw new ConfigError(this.problems)
  }
}

export function loadConfig(env: Env = process.env): Config {
  const reader = new EnvReader(env)

  const config: Config = {
    absUrl: reader.requireString('ABS_URL'),
    absStreamerUser: reader.requireString('ABS_STREAMER_USER'),
    absStreamerPassword: reader.requireString('ABS_STREAMER_PASSWORD'),
    sonosSeedHost: env.SONOS_SEED_HOST,
    port: reader.port(),
    pollIntervalSeconds: reader.positiveNumber('POLL_INTERVAL_SECONDS', 15),
    seekSettleMs: reader.positiveNumber('SEEK_SETTLE_MS', 1000),
    seekToleranceSeconds: reader.positiveNumber('SEEK_TOLERANCE_SECONDS', 3),
    seekRetries: reader.positiveNumber('SEEK_RETRIES', 2),
    progressWriteThresholdSeconds: reader.positiveNumber('PROGRESS_WRITE_THRESHOLD_SECONDS', 5),
    tls: reader.tls(),
  }

  reader.throwIfInvalid()
  return Object.freeze(config)
}

export { ConfigError }
