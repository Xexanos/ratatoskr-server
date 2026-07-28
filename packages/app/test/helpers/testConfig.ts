import type { Config } from '../../src/config/index.js'

// A deterministic Config for tests that build the app but never reach a real ABS or Sonos backend.
// Pass a Partial<Config> to override individual fields.
//
// Every field Config declares is set, at the defaults from SPEC section 7 — except the two back-steps
// (resume rewind, write backoff), which are 0 here so position assertions read the exact number the
// code under test produced; their own behavior is covered in the session-manager tests. Leaving fields
// out would hand the code a config shape production can never hand it.
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerApiKey: 'streamer-key',
    absRequestTimeoutMs: 10_000,
    sonosSeedHost: undefined,
    sonosRequestTimeoutMs: 4000,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    listeningTokenRefreshMarginSeconds: 300,
    shutdownTimeoutMs: 5000,
    resumeRewindSeconds: 0,
    writePositionBackoffSeconds: 0,
    sessionStorePath: undefined,
    sessionStoreKey: undefined,
    tls: undefined,
    validateResponses: true,
    absCaCert: undefined,
    absTlsInsecure: false,
    ...overrides,
  }
}
