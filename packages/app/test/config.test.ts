import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/index.js'

const REQUIRED = {
  ABS_URL: 'http://abs.invalid',
  ABS_STREAMER_USER: 'streamer',
  ABS_STREAMER_PASSWORD: 'secret',
  ALLOW_PLAIN_HTTP: 'true',
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
    expect.assertions(4)
    try {
      loadConfig({ ALLOW_PLAIN_HTTP: 'true' })
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as Error).message).toContain('ABS_URL is required')
      expect((err as Error).message).toContain('ABS_STREAMER_USER is required')
      expect((err as Error).message).toContain('ABS_STREAMER_PASSWORD is required')
    }
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...REQUIRED, PORT: 'not-a-number' })).toThrow(ConfigError)
  })

  it('rejects a PORT outside the valid range', () => {
    expect(() => loadConfig({ ...REQUIRED, PORT: '70000' })).toThrow(ConfigError)
  })

  it('accepts TLS when both cert and key are set, without requiring ALLOW_PLAIN_HTTP', () => {
    const config = loadConfig({
      ABS_URL: REQUIRED.ABS_URL,
      ABS_STREAMER_USER: REQUIRED.ABS_STREAMER_USER,
      ABS_STREAMER_PASSWORD: REQUIRED.ABS_STREAMER_PASSWORD,
      TLS_CERT_PATH: '/tls/cert.pem',
      TLS_KEY_PATH: '/tls/key.pem',
    })
    expect(config.tls).toEqual({ certPath: '/tls/cert.pem', keyPath: '/tls/key.pem' })
  })

  it('rejects TLS_CERT_PATH without TLS_KEY_PATH', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, TLS_CERT_PATH: '/tls/cert.pem', ALLOW_PLAIN_HTTP: undefined }),
    ).toThrow(ConfigError)
  })

  it('rejects plain HTTP without TLS or an explicit opt-out', () => {
    expect(() =>
      loadConfig({
        ABS_URL: REQUIRED.ABS_URL,
        ABS_STREAMER_USER: REQUIRED.ABS_STREAMER_USER,
        ABS_STREAMER_PASSWORD: REQUIRED.ABS_STREAMER_PASSWORD,
      }),
    ).toThrow(ConfigError)
  })
})
