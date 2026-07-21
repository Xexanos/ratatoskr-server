import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'
import { testConfig } from './helpers/testConfig.js'

const TOKENS = { accessToken: 'a', refreshToken: 'r', user: { id: '42', username: 'lars' } }

function appWith(abs: Partial<AbsClient>) {
  return buildApp(testConfig(), { absClient: abs as AbsClient })
}

describe('POST /v1/auth/login', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the tokens from Audiobookshelf on success', async () => {
    const login = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ login })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TOKENS)
    expect(login).toHaveBeenCalledWith('lars', 'secret')
    await app.close()
  })

  it('maps invalid credentials to 401 with a contract Error body', async () => {
    const app = await appWith({ login: vi.fn().mockRejectedValue(new AbsAuthError()) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'lars', password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) })
    await app.close()
  })

  it('maps an upstream failure to 502', async () => {
    const app = await appWith({ login: vi.fn().mockRejectedValue(new AbsUpstreamError()) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'lars', password: 'secret' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('upstream_error')
    await app.close()
  })

  it('rejects a missing field with 400 in the contract Error shape (not Fastifys default)', async () => {
    const login = vi.fn()
    const app = await appWith({ login })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'lars' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'bad_request', message: expect.any(String) })
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/auth/refresh', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a fresh token pair on success', async () => {
    const refresh = vi.fn().mockResolvedValue(TOKENS)
    const app = await appWith({ refresh })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'r' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TOKENS)
    expect(refresh).toHaveBeenCalledWith('r')
    await app.close()
  })

  it('maps an invalid refresh token to 401', async () => {
    const app = await appWith({ refresh: vi.fn().mockRejectedValue(new AbsAuthError()) })
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'stale' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
