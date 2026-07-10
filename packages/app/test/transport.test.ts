import { Agent } from 'undici'
import { describe, expect, it } from 'vitest'
import { buildAbsDispatcher } from '../src/abs/transport.js'
import type { Config } from '../src/config/index.js'

function config(overrides: Partial<Config> = {}): Config {
  return {
    absUrl: 'https://abs.invalid',
    absStreamerUser: 'streamer',
    absStreamerPassword: 'secret',
    sonosSeedHost: undefined,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    tls: undefined,
    validateResponses: false,
    absCaCert: undefined,
    absTlsInsecure: false,
    ...overrides,
  }
}

describe('buildAbsDispatcher', () => {
  it('returns undefined when no custom TLS trust is configured', () => {
    expect(buildAbsDispatcher(config())).toBeUndefined()
  })

  it('builds an Agent when a CA certificate is pinned', () => {
    expect(buildAbsDispatcher(config({ absCaCert: 'PEM' }))).toBeInstanceOf(Agent)
  })

  it('builds an Agent when verification is explicitly disabled', () => {
    expect(buildAbsDispatcher(config({ absTlsInsecure: true }))).toBeInstanceOf(Agent)
  })
})
