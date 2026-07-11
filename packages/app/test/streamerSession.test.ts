import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { StreamerSession } from '../src/abs/streamerSession.js'

function fakeAbs(login: AbsClient['login']): AbsClient {
  return { login } as unknown as AbsClient
}

const tokens = (accessToken: string) => ({
  accessToken,
  refreshToken: 'r',
  user: { id: '1', username: 'streamer' },
})

describe('StreamerSession', () => {
  it('logs in and exposes the access token for media URLs', async () => {
    const login = vi.fn().mockResolvedValue(tokens('access-1'))
    const session = new StreamerSession(fakeAbs(login), 'streamer', 'secret')
    await session.login()

    expect(login).toHaveBeenCalledWith('streamer', 'secret')
    expect(session.currentToken()).toBe('access-1')
  })

  it('throws when the token is requested before login', () => {
    const session = new StreamerSession(fakeAbs(vi.fn()), 'streamer', 'secret')
    expect(() => session.currentToken()).toThrow(/not logged in/)
  })

  it('re-logs in on refresh and returns the fresh token', async () => {
    const login = vi.fn().mockResolvedValueOnce(tokens('access-1')).mockResolvedValueOnce(tokens('access-2'))
    const session = new StreamerSession(fakeAbs(login), 'streamer', 'secret')
    await session.login()
    const fresh = await session.refresh()

    expect(fresh).toBe('access-2')
    expect(session.currentToken()).toBe('access-2')
    expect(login).toHaveBeenCalledTimes(2)
  })
})
