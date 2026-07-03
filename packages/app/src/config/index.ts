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

function requireString(env: Env, name: string, problems: string[]): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    problems.push(`${name} is required`)
    return ''
  }
  return value
}

function positiveNumber(env: Env, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    problems.push(`${name} must be a positive number (got "${raw}")`)
    return fallback
  }
  return value
}

function readTls(env: Env, problems: string[]): TlsConfig | undefined {
  const certPath = env.TLS_CERT_PATH
  const keyPath = env.TLS_KEY_PATH
  const allowPlainHttp = env.ALLOW_PLAIN_HTTP === 'true'

  if (certPath && keyPath) return { certPath, keyPath }
  if (certPath || keyPath) {
    problems.push('TLS_CERT_PATH and TLS_KEY_PATH must both be set, or neither')
    return undefined
  }
  if (!allowPlainHttp) {
    problems.push(
      'no TLS configured (TLS_CERT_PATH/TLS_KEY_PATH). Credentials and refresh tokens must ' +
        'not cross the network in cleartext (SPEC section 14). Configure TLS, or set ' +
        'ALLOW_PLAIN_HTTP=true to explicitly accept the risk (e.g. TLS is terminated by a ' +
        'reverse proxy).',
    )
  }
  return undefined
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []

  const absUrl = requireString(env, 'ABS_URL', problems)
  const absStreamerUser = requireString(env, 'ABS_STREAMER_USER', problems)
  const absStreamerPassword = requireString(env, 'ABS_STREAMER_PASSWORD', problems)

  const port = positiveNumber(env, 'PORT', 8080, problems)
  if (Number.isFinite(port) && (!Number.isInteger(port) || port > 65535)) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`)
  }

  const pollIntervalSeconds = positiveNumber(env, 'POLL_INTERVAL_SECONDS', 15, problems)
  const seekSettleMs = positiveNumber(env, 'SEEK_SETTLE_MS', 1000, problems)
  const seekToleranceSeconds = positiveNumber(env, 'SEEK_TOLERANCE_SECONDS', 3, problems)
  const seekRetries = positiveNumber(env, 'SEEK_RETRIES', 2, problems)
  const progressWriteThresholdSeconds = positiveNumber(env, 'PROGRESS_WRITE_THRESHOLD_SECONDS', 5, problems)

  const tls = readTls(env, problems)

  if (problems.length > 0) throw new ConfigError(problems)

  return Object.freeze({
    absUrl,
    absStreamerUser,
    absStreamerPassword,
    sonosSeedHost: env.SONOS_SEED_HOST,
    port,
    pollIntervalSeconds,
    seekSettleMs,
    seekToleranceSeconds,
    seekRetries,
    progressWriteThresholdSeconds,
    tls,
  })
}

export { ConfigError }
