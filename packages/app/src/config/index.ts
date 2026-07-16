import { accessSync, constants, readFileSync } from 'node:fs'
import { ConfigError } from './errors.js'

export interface TlsConfig {
  certPath: string
  keyPath: string
}

export interface Config {
  absUrl: string
  // An Audiobookshelf API key for a dedicated, stream-only account (SPEC section 14). It is embedded
  // in the media URLs handed to speakers, so it must be low-privilege: a leaked URL then grants at
  // most read/stream of the library, never account takeover. Long-lived (no expiry to manage), which
  // is why the media path uses this rather than the listening user's or a short-lived token.
  absStreamerApiKey: string
  // Per-request cap (ms) on Audiobookshelf HTTP calls. ABS is a network dependency that can hang
  // (down / slow / packet-dropping host), so bound each request: a dead ABS then surfaces as a
  // prompt 502 upstream error rather than a stalled request. Kept comfortably under a typical
  // client read timeout so the client sees the server's mapped error, not its own timeout.
  absRequestTimeoutMs: number
  sonosSeedHost: string | undefined
  // Per-request cap (ms) on Sonos SOAP/discovery I/O. node-sonos-ts sets no timeout, so a speaker
  // that vanishes mid-session (powered off / off the network) would otherwise hang the live reads
  // — and with them GET /v1/sessions/current — indefinitely (SPEC §4). This bounds each call so a
  // dead speaker surfaces as a prompt SonosUpstreamError → 502 instead of a hung request.
  sonosRequestTimeoutMs: number
  port: number
  pollIntervalSeconds: number
  seekSettleMs: number
  seekToleranceSeconds: number
  seekRetries: number
  progressWriteThresholdSeconds: number
  // How many seconds before the listening user's ABS access token expires the sync loop renews it
  // (SPEC section 8: renew proactively, before expiry, so the client's still-valid old token can
  // authenticate the request that fetches the rotated pair).
  listeningTokenRefreshMarginSeconds: number
  // Upper bound on the graceful-shutdown drain (SPEC section 5): a hung final write can't hold the
  // process past this before it exits anyway.
  shutdownTimeoutMs: number
  // Resume back-step (SPEC section 5): on start, resume this many seconds before the stored position
  // so the listener re-orients (the podcast/audiobook convention). 0 disables it.
  resumeRewindSeconds: number
  // Position write backoff (SPEC section 5): subtract this from the position written to ABS, since
  // Sonos's reported RelTime runs slightly ahead of the audible output (buffering). 0 disables it.
  writePositionBackoffSeconds: number
  tls: TlsConfig | undefined
  // Validate every response against the contract schema at runtime (dev/staging aid). Off in
  // production; the tests turn it on. See src/api/responseValidation.ts.
  validateResponses: boolean
  // TLS trust for the upstream Audiobookshelf connection (SPEC section 14). `absCaCert` is a PEM
  // to pin (self-signed / private CA); `absTlsInsecure` disables verification entirely. At most
  // one is set. Both undefined/false → normal verification against the system CAs.
  absCaCert: string | undefined
  absTlsInsecure: boolean
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

  // Like positiveNumber but allows 0, so a knob can be set to 0 to disable the behavior it tunes.
  nonNegativeNumber(name: string, fallback: number): number {
    const raw = this.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      this.problems.push(`${name} must be zero or a positive number (got "${raw}")`)
      return fallback
    }
    return value
  }

  boolean(name: string): boolean {
    return this.env[name] === 'true'
  }

  // ABS_URL must be HTTPS so per-user credentials and tokens (and the phase-4 streamer login)
  // do not cross the network in cleartext (SPEC section 14). Plain HTTP requires an explicit
  // opt-out, mirroring ALLOW_PLAIN_HTTP for Ratatoskr's own listener.
  absUrl(): string {
    const value = this.url('ABS_URL')
    if (value.startsWith('http://') && this.env.ABS_ALLOW_PLAIN_HTTP !== 'true') {
      this.problems.push(
        'ABS_URL uses plain HTTP; Audiobookshelf credentials and tokens would cross the network ' +
          'in cleartext (SPEC section 14). Use https://, or set ABS_ALLOW_PLAIN_HTTP=true to accept ' +
          'the risk (e.g. a trusted LAN or TLS terminated by a reverse proxy).',
      )
    }
    return value
  }

  // TLS trust for the ABS connection. Self-signed / private-CA setups pin a PEM via
  // ABS_CA_CERT (inline) or ABS_CA_CERT_PATH (file); ABS_TLS_INSECURE=true disables verification
  // as an explicit last resort. These are mutually exclusive.
  absTls(): { caCert: string | undefined; insecure: boolean } {
    const inlineCert = this.env.ABS_CA_CERT
    const certPath = this.env.ABS_CA_CERT_PATH
    const insecure = this.boolean('ABS_TLS_INSECURE')

    let caCert: string | undefined
    if (inlineCert && certPath) {
      this.problems.push('ABS_CA_CERT and ABS_CA_CERT_PATH are mutually exclusive; set only one')
    } else if (inlineCert) {
      caCert = inlineCert
    } else if (certPath) {
      try {
        caCert = readFileSync(certPath, 'utf8')
      } catch {
        this.problems.push(`ABS_CA_CERT_PATH is not readable (${certPath})`)
      }
    }

    if ((caCert !== undefined || inlineCert || certPath) && insecure) {
      this.problems.push('ABS_TLS_INSECURE cannot be combined with ABS_CA_CERT/ABS_CA_CERT_PATH')
    }
    return { caCert, insecure }
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
  const absTls = reader.absTls()
  return reader.finalize({
    absUrl: reader.absUrl(),
    absStreamerApiKey: reader.requireString('ABS_STREAMER_API_KEY'),
    absRequestTimeoutMs: reader.positiveNumber('ABS_REQUEST_TIMEOUT_MS', 10000),
    sonosSeedHost: env.SONOS_SEED_HOST,
    sonosRequestTimeoutMs: reader.positiveNumber('SONOS_REQUEST_TIMEOUT_MS', 4000),
    port: reader.port(),
    pollIntervalSeconds: reader.positiveNumber('POLL_INTERVAL_SECONDS', 15),
    seekSettleMs: reader.positiveNumber('SEEK_SETTLE_MS', 1000),
    seekToleranceSeconds: reader.positiveNumber('SEEK_TOLERANCE_SECONDS', 3),
    seekRetries: reader.positiveNumber('SEEK_RETRIES', 2),
    progressWriteThresholdSeconds: reader.positiveNumber('PROGRESS_WRITE_THRESHOLD_SECONDS', 5),
    listeningTokenRefreshMarginSeconds: reader.positiveNumber('LISTENING_TOKEN_REFRESH_MARGIN_SECONDS', 300),
    shutdownTimeoutMs: reader.positiveNumber('SHUTDOWN_TIMEOUT_MS', 5000),
    resumeRewindSeconds: reader.nonNegativeNumber('RESUME_REWIND_SECONDS', 10),
    writePositionBackoffSeconds: reader.nonNegativeNumber('WRITE_POSITION_BACKOFF_SECONDS', 2),
    tls: reader.tls(),
    validateResponses: reader.boolean('VALIDATE_RESPONSES'),
    absCaCert: absTls.caCert,
    absTlsInsecure: absTls.insecure,
  })
}

export { ConfigError }
