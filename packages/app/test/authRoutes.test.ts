import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { AbsClient } from '../src/abs/client.js'
import { testConfig } from './helpers/testConfig.js'

function appWith(abs: Partial<AbsClient>) {
  return buildApp(testConfig(), { absClient: abs as AbsClient })
}

// The 2.0.0 auth surface is declared by the contract but not yet served: both operations need the
// persisted session store to have a token to mint and revoke (SPEC section 8, issue #134), so glue's
// not-implemented stub answers them. Asserted rather than left to chance — a 404 on a documented
// route is a gap someone has to close, and these tests are what fail when it is closed by halves.
describe('POST /v2/auth/login', () => {
  it('is declared but not implemented yet', async () => {
    const login = vi.fn()
    const app = await appWith({ login })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    // Not by falling through to Audiobookshelf either: no credential is forwarded upstream.
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })

  // The request schema is mounted from the contract even though the handler is missing, because
  // Fastify validates before dispatch — so the 400 mapping (SPEC section 6) is already in force.
  it('rejects a missing field with 400 in the contract Error shape (not Fastifys default)', async () => {
    const app = await appWith({ login: vi.fn() })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: { username: 'lars' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'bad_request', message: expect.any(String) })
    await app.close()
  })
})

describe('POST /v2/auth/logout', () => {
  it('is declared but not implemented yet', async () => {
    const app = await appWith({ validateToken: vi.fn() })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/logout',
      headers: { authorization: 'Bearer some-token' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })
})

// /auth/refresh is gone for good, not deprecated: with the server the sole holder of Audiobookshelf
// tokens (ADR-0001) a client has nothing to refresh. Clients that still call it read the frozen
// 1.4.0 contract and are served by the parallel /v1 mount.
describe('POST /auth/refresh', () => {
  it('is not part of the /v2 surface', async () => {
    const app = await appWith({ refresh: vi.fn() })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: { refreshToken: 'r' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })
})
