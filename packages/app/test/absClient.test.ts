import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'

const BASE = 'http://abs.invalid'

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(impl as never)
  vi.stubGlobal('fetch', mock)
  return mock
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const OK_BODY = { accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 42, username: 'lars' } }

describe('AbsClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  describe('login', () => {
    it('posts to /login with x-return-tokens and returns the parsed tokens', async () => {
      const mock = stubFetch(() => jsonResponse(OK_BODY))
      const tokens = await new AbsClient(BASE).login('lars', 'secret')

      const [url, init] = mock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/login`)
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['x-return-tokens']).toBe('true')
      expect(JSON.parse(init.body as string)).toEqual({ username: 'lars', password: 'secret' })
      // user.id is normalized to a string to match the contract's User schema.
      expect(tokens).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: '42', username: 'lars' } })
    })

    it('maps a 401 to AbsAuthError', async () => {
      stubFetch(() => new Response(null, { status: 401 }))
      await expect(new AbsClient(BASE).login('lars', 'wrong')).rejects.toBeInstanceOf(AbsAuthError)
    })

    it('maps a network failure to AbsUpstreamError', async () => {
      stubFetch(() => {
        throw new Error('ECONNREFUSED')
      })
      await expect(new AbsClient(BASE).login('lars', 'secret')).rejects.toBeInstanceOf(AbsUpstreamError)
    })

    it('maps a 5xx to AbsUpstreamError', async () => {
      stubFetch(() => new Response(null, { status: 500 }))
      await expect(new AbsClient(BASE).login('lars', 'secret')).rejects.toBeInstanceOf(AbsUpstreamError)
    })

    it('treats a 2xx without tokens as an upstream fault (e.g. x-return-tokens dropped)', async () => {
      stubFetch(() => jsonResponse({ user: { id: 1, username: 'lars' } }))
      await expect(new AbsClient(BASE).login('lars', 'secret')).rejects.toBeInstanceOf(AbsUpstreamError)
    })

    it('treats an unparseable 2xx body as an upstream fault', async () => {
      stubFetch(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } }))
      await expect(new AbsClient(BASE).login('lars', 'secret')).rejects.toBeInstanceOf(AbsUpstreamError)
    })
  })

  describe('refresh', () => {
    it('posts to /auth/refresh with the refresh token in x-refresh-token', async () => {
      const mock = stubFetch(() => jsonResponse({ ...OK_BODY, accessToken: 'access-2', refreshToken: 'refresh-2' }))
      const tokens = await new AbsClient(BASE).refresh('refresh-1')

      const [url, init] = mock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/auth/refresh`)
      expect((init.headers as Record<string, string>)['x-refresh-token']).toBe('refresh-1')
      expect(tokens.accessToken).toBe('access-2')
      expect(tokens.refreshToken).toBe('refresh-2')
    })

    it('maps a 401 (invalid/expired refresh token) to AbsAuthError', async () => {
      stubFetch(() => new Response(null, { status: 401 }))
      await expect(new AbsClient(BASE).refresh('stale')).rejects.toBeInstanceOf(AbsAuthError)
    })
  })

  describe('probe', () => {
    it('reports ok for a genuine Audiobookshelf /ping', async () => {
      const mock = stubFetch(() => jsonResponse({ success: true }))
      expect(await new AbsClient(BASE).probe()).toBe('ok')
      expect(mock.mock.calls[0][0]).toBe(`${BASE}/ping`)
    })

    it('reports not-audiobookshelf when the host answers but not like ABS', async () => {
      stubFetch(() => jsonResponse({ hello: 'world' }))
      expect(await new AbsClient(BASE).probe()).toBe('not-audiobookshelf')
    })

    it('reports not-audiobookshelf on a non-2xx response', async () => {
      stubFetch(() => new Response(null, { status: 404 }))
      expect(await new AbsClient(BASE).probe()).toBe('not-audiobookshelf')
    })

    it('reports not-audiobookshelf on a non-JSON body', async () => {
      stubFetch(() => new Response('<html>ok</html>', { status: 200 }))
      expect(await new AbsClient(BASE).probe()).toBe('not-audiobookshelf')
    })

    it('reports unreachable on a network error', async () => {
      stubFetch(() => {
        throw new Error('ECONNREFUSED')
      })
      expect(await new AbsClient(BASE).probe()).toBe('unreachable')
    })
  })

  describe('TLS dispatcher', () => {
    it('threads the configured dispatcher into ABS requests', async () => {
      const dispatcher = { sentinel: true } as unknown as RequestInit['dispatcher']
      const mock = stubFetch(() => jsonResponse(OK_BODY))
      await new AbsClient(BASE, dispatcher).login('lars', 'secret')
      const [, init] = mock.mock.calls[0] as [string, RequestInit]
      expect(init.dispatcher).toBe(dispatcher)
    })

    it('omits the dispatcher option when none is configured', async () => {
      const mock = stubFetch(() => jsonResponse(OK_BODY))
      await new AbsClient(BASE).login('lars', 'secret')
      const [, init] = mock.mock.calls[0] as [string, RequestInit]
      expect(init.dispatcher).toBeUndefined()
    })
  })
})
