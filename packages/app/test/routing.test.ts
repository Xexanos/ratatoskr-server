import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp } from '../src/api/app.js'
import type { SonosClient } from '../src/sonos/client.js'
import { testConfig } from './helpers/testConfig.js'

// The clients are never touched: the bearer preHandler and the not-found handler both run before
// any ApiService method. (The NotImplementedError fallback is reachable through the contract again —
// the 2.0.0 auth operations are declared but unimplemented — and is asserted in authRoutes.test.ts.)
function buildTestApp() {
  return buildApp(testConfig(), { absClient: {} as AbsClient, sonosClient: {} as SonosClient })
}

const AUTH = { authorization: 'Bearer user-token' }

describe('routing fallbacks', () => {
  afterEach(() => vi.restoreAllMocks())

  it('enforces the bearer token on a session operation (401 without it, before any handler)', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/v2/sessions/current/pause' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    await app.close()
  })

  it('returns a contract-shaped 404 not_found for an unknown path', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/v2/nope', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', message: expect.any(String) })
    await app.close()
  })
})
