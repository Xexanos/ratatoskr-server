import type { Config } from '../../src/config/index.js'

// A minimal, deterministic Config for tests that build the app but never reach a
// real ABS or Sonos backend. Pass a Partial<Config> to override individual fields.
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerApiKey: 'streamer-key',
    sonosSeedHost: undefined,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    tls: undefined,
    validateResponses: true,
    ...overrides,
  }
}
