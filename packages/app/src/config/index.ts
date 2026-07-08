import { accessSync, constants } from 'node:fs'
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
  // Validate every response against the contract schema at runtime (dev/staging aid). Off in
  // production; the tests turn it on. See src/api/responseValidation.ts.
  validateResponses: boolean
}

type Env = Record<string, string | undefined>

// Validation deliberately aggregates every problem and throws a single ConfigError at the
// end, instead of failing fast on the first — one restart cycle to see everything that's
// wrong. The only way to obtain a Config is via finalize(), which validates as it returns,
// so the check cannot be accidentally skipped.
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

  url(name: string): string {
    const value = this.requireString(name)
    if (value === '') return value
    try {
      const { protocol } = new URL(value)
      if (protocol !== 'http:' && protocol !== 'https:') {
        this.problems.push(`${name} must be an http(s) URL (got "${value}")`)
      }
    } catch {
      this.problems.push(`${name} must be a valid URL (got "${value}")`)
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

  boolean(name: string): boolean {
    return this.env[name] === 'true'
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
    const allowPlainHttp = this.boolean('ALLOW_PLAIN_HTTP')

    if (certPath && keyPath) {
      // Validate readability now, so a typo or an unmounted secret volume fails with the
      // same clear ConfigError as everything else, not a raw ENOENT later in buildApp().
      for (const [name, path] of [
        ['TLS_CERT_PATH', certPath],
        ['TLS_KEY_PATH', keyPath],
      ] as const) {
        try {
          accessSync(path, constants.R_OK)
        } catch {
          this.problems.push(`${name} is not readable (${path})`)
        }
      }
      return { certPath, keyPath }
    }
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

  finalize(config: Config): Config {
    if (this.problems.length > 0) throw new ConfigError(this.problems)
    return Object.freeze(config)
  }
}

export function loadConfig(env: Env = process.env): Config {
  const reader = new EnvReader(env)
  return reader.finalize({
    absUrl: reader.url('ABS_URL'),
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
    validateResponses: reader.boolean('VALIDATE_RESPONSES'),
  })
}

export { ConfigError }
