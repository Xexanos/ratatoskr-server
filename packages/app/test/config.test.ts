import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/index.js'

const CERT = fileURLToPath(new URL('./fixtures/tls/cert.pem', import.meta.url))
const KEY = fileURLToPath(new URL('./fixtures/tls/key.pem', import.meta.url))

const REQUIRED = {
  ABS_URL: 'http://abs.invalid',
  ABS_STREAMER_USER: 'streamer',
  ABS_STREAMER_PASSWORD: 'secret',
  ALLOW_PLAIN_HTTP: 'true',
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
    expect(config.tls).toBeUndefined()
    expect(config.sonosSeedHost).toBeUndefined()
  })

  it('reports every missing required var at once', () => {
    expectConfigError(
      { ALLOW_PLAIN_HTTP: 'true' },
      'ABS_URL is required',
      'ABS_STREAMER_USER is required',
      'ABS_STREAMER_PASSWORD is required',
    )
  })

  it('rejects a malformed ABS_URL rather than misdiagnosing it later as ABS downtime', () => {
    expectConfigError({ ...REQUIRED, ABS_URL: '192.168.1.50:13378' }, 'ABS_URL must be')
  })

  it('rejects a non-numeric PORT', () => {
    expectConfigError({ ...REQUIRED, PORT: 'not-a-number' }, 'PORT must be a positive number')
  })

  it('rejects a PORT outside the valid range', () => {
    expectConfigError({ ...REQUIRED, PORT: '70000' }, 'PORT must be an integer between 1 and 65535')
  })

  it('accepts TLS when both cert and key are readable, without requiring ALLOW_PLAIN_HTTP', () => {
    const config = loadConfig({
      ABS_URL: REQUIRED.ABS_URL,
      ABS_STREAMER_USER: REQUIRED.ABS_STREAMER_USER,
      ABS_STREAMER_PASSWORD: REQUIRED.ABS_STREAMER_PASSWORD,
      TLS_CERT_PATH: CERT,
      TLS_KEY_PATH: KEY,
    })
    expect(config.tls).toEqual({ certPath: CERT, keyPath: KEY })
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
        ABS_STREAMER_USER: REQUIRED.ABS_STREAMER_USER,
        ABS_STREAMER_PASSWORD: REQUIRED.ABS_STREAMER_PASSWORD,
      },
      'no TLS configured',
    )
  })
})
