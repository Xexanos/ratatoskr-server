import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildTestApp } from './helpers/testApp.js'

// The sunset of /v1 (SPEC section 6, ADR-0001): every route under the old prefix answers the same
// unauthenticated 410, whatever the method, path, credentials or body - the one response an installed
// app of the old generation gets, and the only one it can act on.

const UPGRADE_REQUIRED = { code: 'UPGRADE_REQUIRED', message: expect.stringContaining('update the app') }

async function appWithAbs(abs: Partial<AbsClient> = {}) {
  return buildTestApp({ absClient: abs as AbsClient })
}

describe('/v1 is sunset', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['GET', '/v1/health'],
    ['POST', '/v1/auth/login'],
    ['POST', '/v1/auth/refresh'],
    ['GET', '/v1/library/items'],
    ['GET', '/v1/library/items/li_1/cover'],
    ['POST', '/v1/sessions'],
    ['GET', '/v1/sessions/current'],
    ['DELETE', '/v1/sessions/current'],
    ['GET', '/v1/speakers'],
    ['GET', '/v1/something/never/existed'],
    ['GET', '/v1'],
    ['GET', '/v1/'],
    ['GET', '/v1/library/items?token=abc&limit=5'],
    ['HEAD', '/v1/health'],
    ['OPTIONS', '/v1/auth/login'],
  ])('answers %s %s with 410 UPGRADE_REQUIRED in the contract error shape', async (method, url) => {
    const { app } = await appWithAbs()
    const res = await app.inject({ method: method as 'GET', url })
    expect(res.statusCode).toBe(410)
    // A HEAD response carries no body by definition.
    if (method !== 'HEAD') expect(res.json()).toEqual(UPGRADE_REQUIRED)
    await app.close()
  })

  it('answers without a bearer, with a stale one, and never reaches Audiobookshelf', async () => {
    const abs = { validateToken: vi.fn(), login: vi.fn(), refresh: vi.fn(), listItems: vi.fn() }
    const { app } = await appWithAbs(abs)
    for (const headers of [{}, { authorization: 'Bearer stale-abs-access-token' }]) {
      const res = await app.inject({ method: 'GET', url: '/v1/library/items', headers })
      expect(res.statusCode).toBe(410)
      expect(res.json().code).toBe('UPGRADE_REQUIRED')
    }
    for (const fn of Object.values(abs)) expect(fn).not.toHaveBeenCalled()
    await app.close()
  })

  it('ignores the request body, whatever its content type or shape', async () => {
    const { app } = await appWithAbs()
    for (const [payload, contentType] of [
      [JSON.stringify({ username: 'lars', password: 'secret' }), 'application/json'],
      ['{ not json', 'application/json'],
      ['username=lars', 'application/x-www-form-urlencoded'],
      ['plain', 'text/plain'],
      // Far past Fastify's default body limit (1 MiB): still the 410, not a 413.
      ['x'.repeat(2 * 1024 * 1024), 'application/json'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload,
        headers: { 'content-type': contentType },
      })
      expect(res.statusCode, `${contentType} ${payload.length}`).toBe(410)
      expect(res.json().code, contentType).toBe('UPGRADE_REQUIRED')
    }
    await app.close()
  })

  it('does not count towards the credential rate limit', async () => {
    const { app } = await appWithAbs()
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'a', password: 'b' } })
      expect(res.statusCode).toBe(410)
    }
    await app.close()
  })

  it('leaves the rest of the surface alone: /v2 is served, other unknown paths stay 404', async () => {
    const { app } = await appWithAbs({ probe: vi.fn().mockResolvedValue('ok') } as Partial<AbsClient>)
    expect((await app.inject({ method: 'GET', url: '/v2/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v10/health' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1x' })).statusCode).toBe(404)
    await app.close()
  })
})
