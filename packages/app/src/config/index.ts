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
  // Per-request cap (ms) on Audiobookshelf HTTP calls — rationale on AbsClient's requestTimeoutMs.
  absRequestTimeoutMs: number
  sonosSeedHost: string | undefined
  // Per-request cap (ms) on Sonos SOAP/discovery I/O — rationale on SonosClient's requestTimeoutMs.
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
  // Where the encrypted session store lives (SPEC section 8) and the operator-supplied key that
  // encrypts it (decoded by EnvReader's sessionStoreKey). Both required: the store is what keeps
  // devices signed in, and it holds every device's Audiobookshelf credentials, so there is no
  // degraded mode to fall back to. No default for the path: which directory survives a container
  // recreation is a deployment fact, not something this process can guess, so the container
  // entrypoint supplies it the same way it supplies TLS_CERT_PATH/TLS_KEY_PATH.
  sessionStorePath: string
  sessionStoreKey: Buffer
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

  // ABS_URL must be HTTPS so per-user credentials and tokens do not cross the network in
  // cleartext (SPEC section 14). Plain HTTP requires an explicit opt-out, mirroring
  // ALLOW_PLAIN_HTTP for Ratatoskr's own listener.
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

  // A secret that may be given inline or as a path to read it from — the file form is what makes
  // it mountable as a Docker/Compose secret. The two are mutually exclusive, and an unreadable
  // file is reported rather than passed over, so a typo'd or unmounted secret cannot look like
  // "not configured". The reported name comes back with the value, so the caller's own error
  // messages name the variable the operator actually set.
  private inlineOrFile(inlineName: string, fileName: string): { name: string; value: string } | undefined {
    const inline = this.env[inlineName]
    const path = this.env[fileName]
    if (inline && path) {
      this.problems.push(`${inlineName} and ${fileName} are mutually exclusive; set only one`)
      return undefined
    }
    if (inline) return { name: inlineName, value: inline }
    if (!path) return undefined
    try {
      return { name: fileName, value: readFileSync(path, 'utf8') }
    } catch {
      this.problems.push(`${fileName} is not readable (${path})`)
      return undefined
    }
  }

  // TLS trust for the ABS connection. Self-signed / private-CA setups pin a PEM via
  // ABS_CA_CERT (inline) or ABS_CA_CERT_PATH (file); ABS_TLS_INSECURE=true disables verification
  // as an explicit last resort. These are mutually exclusive.
  absTls(): { caCert: string | undefined; insecure: boolean } {
    const pinned = this.inlineOrFile('ABS_CA_CERT', 'ABS_CA_CERT_PATH')
    const insecure = this.boolean('ABS_TLS_INSECURE')
    // Keyed off the raw env, not off `pinned`: an unreadable PEM path is still an attempt to pin,
    // and reporting the contradiction with ABS_TLS_INSECURE too spares a second restart.
    if ((this.env.ABS_CA_CERT || this.env.ABS_CA_CERT_PATH) && insecure) {
      this.problems.push('ABS_TLS_INSECURE cannot be combined with ABS_CA_CERT/ABS_CA_CERT_PATH')
    }
    return { caCert: pinned?.value, insecure }
  }

  // Key for the encrypted session store (SPEC sections 7 and 8). Required: without it the store
  // cannot be opened, and every sign-in would fail — so refuse at boot rather than at some user's
  // first attempt to log in.
  //
  // AES-256-GCM needs exactly 32 bytes; both common encodings of a random key are accepted. The
  // value is trimmed because a key file written by `docker secret` or a shell redirect normally
  // ends in a newline, which would otherwise decode to a wrong-length key.
  //
  // An empty buffer stands in for "unusable" so validation can continue and report every other
  // problem too; finalize() is what turns the collected problems into the refusal.
  sessionStoreKey(): Buffer {
    const configured = this.inlineOrFile('SESSION_STORE_KEY', 'SESSION_STORE_KEY_FILE')
    if (configured === undefined) {
      // inlineOrFile has already reported the "set both" and "file unreadable" cases; only the
      // genuinely unconfigured one is left to name here.
      if (!this.env.SESSION_STORE_KEY && !this.env.SESSION_STORE_KEY_FILE) {
        this.problems.push(
          'SESSION_STORE_KEY (or SESSION_STORE_KEY_FILE) is required: it encrypts the store that ' +
            'keeps signed-in devices signed in and holds their Audiobookshelf credentials (SPEC ' +
            'section 8). Generate one with: openssl rand -base64 32 — and keep a copy, because the ' +
            'store cannot be read back without it.',
        )
      }
      return Buffer.alloc(0)
    }
    const value = configured.value.trim()
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex')
    if (/^[A-Za-z0-9+/\-_]{43}=?$/.test(value)) {
      const decoded = Buffer.from(value, 'base64')
      if (decoded.length === 32) return decoded
    }
    this.problems.push(
      `${configured.name} must be a 256-bit key, base64- or hex-encoded (generate one with: openssl rand -base64 32)`,
    )
    return Buffer.alloc(0)
  }

  // Where that store file lives — required, and without a default for the reason on Config's
  // sessionStorePath. The container entrypoint is what supplies it there.
  sessionStorePath(): string {
    const value = this.env.SESSION_STORE_PATH?.trim()
    if (!value) {
      this.problems.push(
        'SESSION_STORE_PATH is required: it is the file that keeps signed-in devices signed in ' +
          'across a restart (SPEC section 8). It has no default on purpose — point it at a ' +
          'directory that survives a restart of this process (the container entrypoint sets it to ' +
          "/data/sessions.enc, on the image's own persistent volume).",
      )
      return ''
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
    sessionStorePath: reader.sessionStorePath(),
    sessionStoreKey: reader.sessionStoreKey(),
    tls: reader.tls(),
    validateResponses: reader.boolean('VALIDATE_RESPONSES'),
    absCaCert: absTls.caCert,
    absTlsInsecure: absTls.insecure,
  })
}

export { ConfigError }
