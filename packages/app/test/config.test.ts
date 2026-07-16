import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/index.js'

const CERT = fileURLToPath(new URL('./fixtures/tls/cert.pem', import.meta.url))
const KEY = fileURLToPath(new URL('./fixtures/tls/key.pem', import.meta.url))

const REQUIRED = {
  ABS_URL: 'http://abs.invalid',
  ABS_STREAMER_API_KEY: 'streamer-key',
  ALLOW_PLAIN_HTTP: 'true',
  ABS_ALLOW_PLAIN_HTTP: 'true',
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
      ABS_URL: REQUIRED.ABS_URL,
      ABS_STREAMER_API_KEY: REQUIRED.ABS_STREAMER_API_KEY,
      ABS_ALLOW_PLAIN_HTTP: 'true',
      TLS_CERT_PATH: CERT,
      TLS_KEY_PATH: KEY,
    })
    expect(config.tls).toEqual({ certPath: CERT, keyPath: KEY })
  })

  it('accepts an https ABS_URL without requiring ABS_ALLOW_PLAIN_HTTP', () => {
    const config = loadConfig({
      ABS_URL: 'https://abs.invalid',
      ABS_STREAMER_API_KEY: REQUIRED.ABS_STREAMER_API_KEY,
      ALLOW_PLAIN_HTTP: 'true',
    })
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
    expectConfigError(
      {
        ABS_URL: REQUIRED.ABS_URL,
        ABS_STREAMER_API_KEY: REQUIRED.ABS_STREAMER_API_KEY,
      },
      'no TLS configured',
    )
  })
})
