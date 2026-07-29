import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/index.js'

const CERT = fileURLToPath(new URL('./fixtures/tls/cert.pem', import.meta.url))
const KEY = fileURLToPath(new URL('./fixtures/tls/key.pem', import.meta.url))
// The fixture carries a trailing newline on purpose (see EnvReader.sessionStoreKey).
const SESSION_KEY_FILE = fileURLToPath(new URL('./fixtures/session-store.key', import.meta.url))
const SESSION_KEY = Buffer.alloc(32, 0x2a)
const SESSION_KEY_B64 = SESSION_KEY.toString('base64')

const REQUIRED = {
  ABS_URL: 'http://abs.invalid',
  ABS_STREAMER_API_KEY: 'streamer-key',
  ALLOW_PLAIN_HTTP: 'true',
  ABS_ALLOW_PLAIN_HTTP: 'true',
  SESSION_STORE_KEY: SESSION_KEY_B64,
  SESSION_STORE_PATH: '/data/sessions.enc',
}

// Asserts a ConfigError is thrown whose aggregated message contains each expected
// fragment — so tests pin down *which* problem was reported, not merely that it failed.
function expectConfigError(env: Record<string, string | undefined>, ...expected: string[]): void {
  let error: unknown
  try {
    loadConfig(env)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ConfigError)
  const message = (error as Error).message
  for (const fragment of expected) expect(message).toContain(fragment)
}

describe('loadConfig', () => {
  it('applies documented defaults when only required vars are set', () => {
    const config = loadConfig(REQUIRED)
    expect(config.port).toBe(8080)
    expect(config.pollIntervalSeconds).toBe(15)
    expect(config.seekSettleMs).toBe(1000)
    expect(config.seekToleranceSeconds).toBe(3)
    expect(config.seekRetries).toBe(2)
    expect(config.progressWriteThresholdSeconds).toBe(5)
    expect(config.resumeRewindSeconds).toBe(10)
    expect(config.writePositionBackoffSeconds).toBe(2)
    expect(config.sonosRequestTimeoutMs).toBe(4000)
    expect(config.absRequestTimeoutMs).toBe(10000)
    expect(config.tls).toBeUndefined()
    expect(config.sonosSeedHost).toBeUndefined()
    expect(config.validateResponses).toBe(false)
    expect(config.absCaCert).toBeUndefined()
    expect(config.absTlsInsecure).toBe(false)
  })

  it('enables response validation only when VALIDATE_RESPONSES=true', () => {
    expect(loadConfig({ ...REQUIRED, VALIDATE_RESPONSES: 'true' }).validateResponses).toBe(true)
    expect(loadConfig({ ...REQUIRED, VALIDATE_RESPONSES: '1' }).validateResponses).toBe(false)
  })

  it('reports every missing required var at once', () => {
    expectConfigError(
      { ALLOW_PLAIN_HTTP: 'true' },
      'ABS_URL is required',
      'ABS_STREAMER_API_KEY is required',
      'SESSION_STORE_KEY (or SESSION_STORE_KEY_FILE) is required',
      'SESSION_STORE_PATH is required',
    )
  })

  it('rejects a malformed ABS_URL rather than misdiagnosing it later as ABS downtime', () => {
    expectConfigError({ ...REQUIRED, ABS_URL: '192.168.1.50:13378' }, 'ABS_URL must be')
  })

  it('accepts 0 for the rewind/backoff knobs (disables them) but rejects a negative value', () => {
    const config = loadConfig({ ...REQUIRED, RESUME_REWIND_SECONDS: '0', WRITE_POSITION_BACKOFF_SECONDS: '4' })
    expect(config.resumeRewindSeconds).toBe(0)
    expect(config.writePositionBackoffSeconds).toBe(4)
    expectConfigError({ ...REQUIRED, RESUME_REWIND_SECONDS: '-1' }, 'RESUME_REWIND_SECONDS must be zero or a positive number')
  })

  it('rejects a non-numeric PORT', () => {
    expectConfigError({ ...REQUIRED, PORT: 'not-a-number' }, 'PORT must be a positive number')
  })

  it('overrides the Sonos request timeout and rejects a non-positive value', () => {
    expect(loadConfig({ ...REQUIRED, SONOS_REQUEST_TIMEOUT_MS: '1500' }).sonosRequestTimeoutMs).toBe(1500)
    expectConfigError({ ...REQUIRED, SONOS_REQUEST_TIMEOUT_MS: '0' }, 'SONOS_REQUEST_TIMEOUT_MS must be a positive number')
  })

  it('overrides the ABS request timeout and rejects a non-positive value', () => {
    expect(loadConfig({ ...REQUIRED, ABS_REQUEST_TIMEOUT_MS: '2000' }).absRequestTimeoutMs).toBe(2000)
    expectConfigError({ ...REQUIRED, ABS_REQUEST_TIMEOUT_MS: '0' }, 'ABS_REQUEST_TIMEOUT_MS must be a positive number')
  })

  it('rejects a PORT outside the valid range', () => {
    expectConfigError({ ...REQUIRED, PORT: '70000' }, 'PORT must be an integer between 1 and 65535')
  })

  it('accepts TLS when both cert and key are readable, without requiring ALLOW_PLAIN_HTTP', () => {
    const config = loadConfig({
      ...REQUIRED,
      ALLOW_PLAIN_HTTP: undefined,
      TLS_CERT_PATH: CERT,
      TLS_KEY_PATH: KEY,
    })
    expect(config.tls).toEqual({ certPath: CERT, keyPath: KEY })
  })

  it('accepts an https ABS_URL without requiring ABS_ALLOW_PLAIN_HTTP', () => {
    const config = loadConfig({ ...REQUIRED, ABS_URL: 'https://abs.invalid', ABS_ALLOW_PLAIN_HTTP: undefined })
    expect(config.absUrl).toBe('https://abs.invalid')
  })

  it('rejects a plain-HTTP ABS_URL without the explicit opt-out', () => {
    expectConfigError(
      { ...REQUIRED, ABS_ALLOW_PLAIN_HTTP: undefined },
      'ABS_URL uses plain HTTP',
    )
  })

  it('trusts a self-signed ABS cert via inline PEM or file path', () => {
    const inline = loadConfig({ ...REQUIRED, ABS_CA_CERT: 'PEM-INLINE' })
    expect(inline.absCaCert).toBe('PEM-INLINE')
    const fromPath = loadConfig({ ...REQUIRED, ABS_CA_CERT_PATH: CERT })
    expect(fromPath.absCaCert).toContain('BEGIN CERTIFICATE')
  })

  it('rejects an unreadable ABS_CA_CERT_PATH', () => {
    expectConfigError({ ...REQUIRED, ABS_CA_CERT_PATH: '/nonexistent/abs-ca.pem' }, 'ABS_CA_CERT_PATH is not readable')
  })

  it('rejects ABS_CA_CERT and ABS_CA_CERT_PATH set together', () => {
    expectConfigError({ ...REQUIRED, ABS_CA_CERT: 'PEM', ABS_CA_CERT_PATH: CERT }, 'mutually exclusive')
  })

  it('rejects a CA together with ABS_TLS_INSECURE', () => {
    expectConfigError(
      { ...REQUIRED, ABS_CA_CERT: 'PEM', ABS_TLS_INSECURE: 'true' },
      'ABS_TLS_INSECURE cannot be combined',
    )
  })

  it('accepts ABS_TLS_INSECURE on its own', () => {
    expect(loadConfig({ ...REQUIRED, ABS_TLS_INSECURE: 'true' }).absTlsInsecure).toBe(true)
  })

  it('rejects an unreadable TLS cert path instead of crashing later with ENOENT', () => {
    expectConfigError(
      {
        ...REQUIRED,
        ALLOW_PLAIN_HTTP: undefined,
        TLS_CERT_PATH: '/nonexistent/cert.pem',
        TLS_KEY_PATH: '/nonexistent/key.pem',
      },
      'TLS_CERT_PATH is not readable',
    )
  })

  it('rejects TLS_CERT_PATH without TLS_KEY_PATH', () => {
    expectConfigError(
      { ...REQUIRED, TLS_CERT_PATH: CERT, ALLOW_PLAIN_HTTP: undefined },
      'TLS_CERT_PATH and TLS_KEY_PATH must both be set',
    )
  })

  it('rejects plain HTTP without TLS or an explicit opt-out', () => {
    expectConfigError({ ...REQUIRED, ALLOW_PLAIN_HTTP: undefined }, 'no TLS configured')
  })

  it('reads the session store key from a value or a Docker-secret file, trimming the trailing newline', () => {
    expect(loadConfig({ ...REQUIRED, SESSION_STORE_KEY: SESSION_KEY_B64 }).sessionStoreKey).toEqual(SESSION_KEY)
    expect(
      loadConfig({ ...REQUIRED, SESSION_STORE_KEY: undefined, SESSION_STORE_KEY_FILE: SESSION_KEY_FILE })
        .sessionStoreKey,
    ).toEqual(SESSION_KEY)
  })

  it('accepts a hex-encoded session store key as well as base64', () => {
    expect(loadConfig({ ...REQUIRED, SESSION_STORE_KEY: SESSION_KEY.toString('hex') }).sessionStoreKey).toEqual(
      SESSION_KEY,
    )
  })

  it('rejects SESSION_STORE_KEY and SESSION_STORE_KEY_FILE set together', () => {
    expectConfigError(
      { ...REQUIRED, SESSION_STORE_KEY: SESSION_KEY_B64, SESSION_STORE_KEY_FILE: SESSION_KEY_FILE },
      'mutually exclusive',
    )
  })

  it('rejects an unreadable SESSION_STORE_KEY_FILE', () => {
    expectConfigError(
      { ...REQUIRED, SESSION_STORE_KEY: undefined, SESSION_STORE_KEY_FILE: '/nonexistent/session.key' },
      'is not readable',
    )
  })

  it('rejects a key that is not 256 bits, and says how to generate one', () => {
    expectConfigError({ ...REQUIRED, SESSION_STORE_KEY: 'too-short' }, 'SESSION_STORE_KEY must be a 256-bit key')
    expectConfigError({ ...REQUIRED, SESSION_STORE_KEY: 'too-short' }, 'openssl rand -base64 32')
    expectConfigError({ ...REQUIRED, SESSION_STORE_KEY: Buffer.alloc(16).toString('base64') }, 'must be a 256-bit key')
  })

  // Required from the /v2 auth model on (SPEC section 8): the store is what keeps devices signed
  // in and holds their ABS credentials, so an unconfigured key has no degraded mode to fall back
  // to — and the operator has to learn that at boot, not from the first user who cannot log in.
  it('refuses to start without a session store key, and says how to generate one', () => {
    expectConfigError(
      { ...REQUIRED, SESSION_STORE_KEY: undefined },
      'SESSION_STORE_KEY (or SESSION_STORE_KEY_FILE) is required',
      'openssl rand -base64 32',
    )
  })

  // Still no default for the path (SPEC section 7) — but unset is now a refusal rather than a
  // silently absent store, because guessing a directory that does not outlive a container
  // recreation would sign every device out on the next restart.
  it('requires the store path and takes it verbatim', () => {
    expectConfigError({ ...REQUIRED, SESSION_STORE_PATH: undefined }, 'SESSION_STORE_PATH is required')
    expect(loadConfig({ ...REQUIRED, SESSION_STORE_PATH: '/data/s.enc' }).sessionStorePath).toBe('/data/s.enc')
  })
})
