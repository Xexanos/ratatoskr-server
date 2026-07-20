import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { InvalidCursorError } from '../src/abs/cursor.js'
import { AbsNotFoundError, AbsUpstreamError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'

function testConfig(): Config {
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
  }
}

const AUTH = { authorization: 'Bearer user-token' }
const SUMMARY = { id: 'li_1', title: 'Alpha', durationSeconds: 3600, coverUrl: '/v1/library/items/li_1/cover' }
const ITEM = { ...SUMMARY, progress: { positionSeconds: 0, isFinished: false } }

function appWith(abs: Partial<AbsClient>) {
  return buildApp(testConfig(), { absClient: abs as AbsClient })
}

describe('GET /v1/library/items', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the projected page and forwards the token, query and default limit', async () => {
    const listItems = vi.fn().mockResolvedValue({ items: [SUMMARY], nextCursor: null })
    const app = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items?q=alpha', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [SUMMARY], nextCursor: null })
    expect(listItems).toHaveBeenCalledWith('user-token', { searchQuery: 'alpha', limit: 50, cursor: undefined })
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const listItems = vi.fn()
    const app = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(listItems).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps an upstream failure to 502', async () => {
    const app = await appWith({ listItems: vi.fn().mockRejectedValue(new AbsUpstreamError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items', headers: AUTH })
    expect(res.statusCode).toBe(502)
    await app.close()
  })

  it('maps a bad cursor to 400 with a contract Error body', async () => {
    const app = await appWith({ listItems: vi.fn().mockRejectedValue(new InvalidCursorError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items?cursor=garbage', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'bad_request', message: expect.any(String) })
    await app.close()
  })

  it('rejects an out-of-range limit with 400', async () => {
    const app = await appWith({ listItems: vi.fn() })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items?limit=500', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('bad_request')
    await app.close()
  })
})

describe('GET /v1/library/items/:itemId', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the item for a valid id', async () => {
    const getItem = vi.fn().mockResolvedValue(ITEM)
    const app = await appWith({ getItem })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(ITEM)
    expect(getItem).toHaveBeenCalledWith('user-token', 'li_1')
    await app.close()
  })

  it('maps a missing item to 404', async () => {
    const app = await appWith({ getItem: vi.fn().mockRejectedValue(new AbsNotFoundError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/ghost', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const app = await appWith({ getItem: vi.fn() })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('GET /v1/library/items/:itemId/cover', () => {
  afterEach(() => vi.restoreAllMocks())

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

  it('serves the proxied bytes with the upstream content type and no cache headers', async () => {
    const getItemCover = vi.fn().mockResolvedValue({ contentType: 'image/png', body: PNG })
    const app = await appWith({ getItemCover })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1/cover?h=240', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    // Deliberately no caching guidance (issue #100): ABS sends no cache headers on this
    // path, and the only client caches independently of them.
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers.etag).toBeUndefined()
    expect(res.headers['last-modified']).toBeUndefined()
    expect(res.rawPayload).toEqual(PNG)
    expect(getItemCover).toHaveBeenCalledWith('user-token', 'li_1', 240)
    await app.close()
  })

  it('forwards no height when h is omitted', async () => {
    const getItemCover = vi.fn().mockResolvedValue({ contentType: 'image/jpeg', body: PNG })
    const app = await appWith({ getItemCover })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1/cover', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(getItemCover).toHaveBeenCalledWith('user-token', 'li_1', undefined)
    await app.close()
  })

  it('rejects an out-of-range h with 400', async () => {
    const getItemCover = vi.fn()
    const app = await appWith({ getItemCover })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1/cover?h=9000', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('bad_request')
    expect(getItemCover).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps a missing cover to 404', async () => {
    const app = await appWith({ getItemCover: vi.fn().mockRejectedValue(new AbsNotFoundError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/ghost/cover', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('not_found')
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const getItemCover = vi.fn()
    const app = await appWith({ getItemCover })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items/li_1/cover' })
    expect(res.statusCode).toBe(401)
    expect(getItemCover).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('GET /v1/library/in-progress', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the shelf and forwards the token with the default limit', async () => {
    const listInProgressItems = vi.fn().mockResolvedValue({ items: [SUMMARY] })
    const app = await appWith({ listInProgressItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/in-progress', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [SUMMARY] })
    expect(listInProgressItems).toHaveBeenCalledWith('user-token', 25)
    await app.close()
  })

  it('forwards an explicit limit', async () => {
    const listInProgressItems = vi.fn().mockResolvedValue({ items: [] })
    const app = await appWith({ listInProgressItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/in-progress?limit=10', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(listInProgressItems).toHaveBeenCalledWith('user-token', 10)
    await app.close()
  })

  it('rejects an out-of-range limit with 400', async () => {
    const listInProgressItems = vi.fn()
    const app = await appWith({ listInProgressItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/in-progress?limit=99', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('bad_request')
    expect(listInProgressItems).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a request with no bearer token as 401', async () => {
    const listInProgressItems = vi.fn()
    const app = await appWith({ listInProgressItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/in-progress' })
    expect(res.statusCode).toBe(401)
    expect(listInProgressItems).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps an upstream failure to 502', async () => {
    const app = await appWith({ listInProgressItems: vi.fn().mockRejectedValue(new AbsUpstreamError()) })
    const res = await app.inject({ method: 'GET', url: '/v1/library/in-progress', headers: AUTH })
    expect(res.statusCode).toBe(502)
    await app.close()
  })
})
