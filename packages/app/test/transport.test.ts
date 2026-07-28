import { Agent } from 'undici'
import { describe, expect, it } from 'vitest'
import { buildAbsDispatcher } from '../src/abs/transport.js'
import type { Config } from '../src/config/index.js'
import { testConfig } from './helpers/testConfig.js'

// The shared helper with the two fields this file's subject depends on: an https upstream (the
// dispatcher exists only to carry TLS trust) and no response validation.
function config(overrides: Partial<Config> = {}): Config {
  return testConfig({ absUrl: 'https://abs.invalid', validateResponses: false, ...overrides })
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
