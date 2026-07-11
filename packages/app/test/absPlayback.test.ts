import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsNotFoundError, AbsUpstreamError, ItemNotPlayableError } from '../src/abs/errors.js'

const BASE = 'http://abs.invalid'

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(impl as never)
  vi.stubGlobal('fetch', mock)
  return mock
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('AbsClient.getPlaybackManifest', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('projects and orders audio files, ignoring the whole-book duration', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        media: {
          duration: 999,
          audioFiles: [
            { ino: '20', index: 2, duration: 200, mimeType: 'audio/mp4' },
            { ino: '10', index: 1, duration: 100, mimeType: 'audio/mpeg' },
          ],
        },
      }),
    )
    const manifest = await new AbsClient(BASE).getPlaybackManifest('user-token', 'li_1')

    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/items/li_1`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token')
    expect(manifest.tracks).toEqual([
      { ino: '10', durationSeconds: 100, mimeType: 'audio/mpeg' },
      { ino: '20', durationSeconds: 200, mimeType: 'audio/mp4' },
    ])
    expect(manifest.totalDurationSeconds).toBe(300)
  })

  it('rejects a book with no audio files', async () => {
    stubFetch(() => jsonResponse({ media: { audioFiles: [] } }))
    await expect(new AbsClient(BASE).getPlaybackManifest('t', 'li_1')).rejects.toBeInstanceOf(ItemNotPlayableError)
  })

  it('rejects a track with a non-positive duration', async () => {
    stubFetch(() => jsonResponse({ media: { audioFiles: [{ ino: '1', index: 1, duration: 0, mimeType: 'audio/mpeg' }] } }))
    await expect(new AbsClient(BASE).getPlaybackManifest('t', 'li_1')).rejects.toBeInstanceOf(ItemNotPlayableError)
  })

  it('rejects a track missing its mime type', async () => {
    stubFetch(() => jsonResponse({ media: { audioFiles: [{ ino: '1', index: 1, duration: 100 }] } }))
    await expect(new AbsClient(BASE).getPlaybackManifest('t', 'li_1')).rejects.toBeInstanceOf(ItemNotPlayableError)
  })
})

describe('AbsClient.writeProgress', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes /api/me/progress with the current time, duration, fraction and finished flag', async () => {
    const mock = stubFetch(() => new Response(null, { status: 200 }))
    await new AbsClient(BASE).writeProgress('user-token', 'li_1', {
      currentTimeSeconds: 30,
      durationSeconds: 120,
      isFinished: false,
    })

    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/me/progress/li_1`)
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token')
    expect(JSON.parse(init.body as string)).toEqual({ currentTime: 30, duration: 120, progress: 0.25, isFinished: false })
  })

  it('sends progress 1 when finished', async () => {
    const mock = stubFetch(() => new Response(null, { status: 200 }))
    await new AbsClient(BASE).writeProgress('t', 'li_1', { currentTimeSeconds: 120, durationSeconds: 120, isFinished: true })
    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string).progress).toBe(1)
  })

  it('maps an upstream failure to AbsUpstreamError', async () => {
    stubFetch(() => new Response(null, { status: 500 }))
    await expect(
      new AbsClient(BASE).writeProgress('t', 'li_1', { currentTimeSeconds: 1, durationSeconds: 2, isFinished: false }),
    ).rejects.toBeInstanceOf(AbsUpstreamError)
  })

  it('maps a 401 to AbsAuthError and a 404 to AbsNotFoundError', async () => {
    stubFetch(() => new Response(null, { status: 401 }))
    await expect(
      new AbsClient(BASE).writeProgress('t', 'li_1', { currentTimeSeconds: 1, durationSeconds: 2, isFinished: false }),
    ).rejects.toBeInstanceOf(AbsAuthError)

    stubFetch(() => new Response(null, { status: 404 }))
    await expect(
      new AbsClient(BASE).writeProgress('t', 'li_1', { currentTimeSeconds: 1, durationSeconds: 2, isFinished: false }),
    ).rejects.toBeInstanceOf(AbsNotFoundError)
  })
})
