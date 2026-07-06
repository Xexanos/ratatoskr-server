import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsNotFoundError, AbsUpstreamError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'

function testConfig(): Config {
  return {
    absUrl: 'http://abs.invalid',
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
  }
}

const AUTH = { authorization: 'Bearer user-token' }
const SUMMARY = { id: 'li_1', title: 'Alpha', durationSeconds: 3600, coverUrl: null }
const ITEM = { ...SUMMARY, progress: { positionSeconds: 0, isFinished: false } }

function appWith(abs: Partial<AbsClient>) {
  return buildApp(testConfig(), { validateResponses: true, absClient: abs as AbsClient })
}

describe('GET /v1/library/items', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the projected page and forwards the token, query and default limit', async () => {
    const listItems = vi.fn().mockResolvedValue({ items: [SUMMARY], nextCursor: null })
    const app = await appWith({ listItems })
    const res = await app.inject({ method: 'GET', url: '/v1/library/items?q=alpha', headers: AUTH })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [SUMMARY], nextCursor: null })
    expect(listItems).toHaveBeenCalledWith('user-token', { q: 'alpha', limit: 50, cursor: undefined })
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
