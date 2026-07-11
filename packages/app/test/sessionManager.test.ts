import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient, PlaybackManifest } from '../src/abs/client.js'
import type { StreamerSession } from '../src/abs/streamerSession.js'
import type { Config } from '../src/config/index.js'
import type { SonosClient } from '../src/sonos/client.js'
import { SessionManager } from '../src/playback/sessionManager.js'
import { NoActiveSessionError } from '../src/playback/errors.js'

const MANIFEST: PlaybackManifest = {
  itemId: 'li_1',
  tracks: [
    { ino: '10', durationSeconds: 100, mimeType: 'audio/mpeg' },
    { ino: '20', durationSeconds: 200, mimeType: 'audio/mp4' },
  ],
  totalDurationSeconds: 300,
}

function build(overrides: { positionSeconds?: number } = {}) {
  const abs = {
    getPlaybackManifest: vi.fn().mockResolvedValue(MANIFEST),
    getProgress: vi.fn().mockResolvedValue({ positionSeconds: overrides.positionSeconds ?? 150, isFinished: false }),
    writeProgress: vi.fn().mockResolvedValue(undefined),
  }
  const sonos = {
    startPlayback: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getPosition: vi.fn().mockResolvedValue({ trackIndex: 1, relTimeSeconds: 50 }),
    getTransportState: vi.fn().mockResolvedValue('PLAYING'),
  }
  const streamer = {
    currentToken: vi.fn().mockReturnValue('streamer-tok'),
    refresh: vi.fn().mockResolvedValue('refreshed-tok'),
  }
  const config = {
    absUrl: 'http://abs.invalid',
    seekSettleMs: 0,
    seekToleranceSeconds: 3,
    seekRetries: 2,
  } as unknown as Config

  const manager = new SessionManager({
    abs: abs as unknown as AbsClient,
    sonos: sonos as unknown as SonosClient,
    streamer: streamer as unknown as StreamerSession,
    config,
  })
  return { manager, abs, sonos, streamer }
}

describe('SessionManager', () => {
  let ctx: ReturnType<typeof build>
  beforeEach(() => (ctx = build()))

  describe('start', () => {
    it('builds media URLs with the streamer token and plays the queue', async () => {
      await ctx.manager.start('user-tok', 'refresh-tok', 'li_1', 'RINCON_1')

      const [speakerId, plan] = ctx.sonos.startPlayback.mock.calls[0] as [string, { tracks: { url: string }[] }]
      expect(speakerId).toBe('RINCON_1')
      expect(plan.tracks.map((track) => track.url)).toEqual([
        'http://abs.invalid/api/items/li_1/file/10?token=streamer-tok',
        'http://abs.invalid/api/items/li_1/file/20?token=streamer-tok',
      ])
    })

    it('resumes from the stored ABS position (seek to track + offset)', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      // 150s into [100,200] -> track index 1, offset 50.
      const [, seekPlan] = ctx.sonos.seek.mock.calls[0] as [string, { trackIndex: number; offsetSeconds: number }]
      expect(seekPlan.trackIndex).toBe(1)
      expect(seekPlan.offsetSeconds).toBe(50)
    })

    it('returns a Session reflecting the resume position', async () => {
      const session = await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      expect(session).toMatchObject({
        itemId: 'li_1',
        speakerId: 'RINCON_1',
        state: 'playing',
        positionSeconds: 150,
        durationSeconds: 300,
      })
      expect(typeof session.updatedAt).toBe('string')
    })

    it('does not seek when there is no stored progress', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      expect(ctx.sonos.seek).not.toHaveBeenCalled()
    })

    it('stops and writes back a previous session before starting a new one', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      await ctx.manager.start('user-tok', undefined, 'li_2', 'RINCON_2')
      // The first session's progress was written on replacement.
      expect(ctx.abs.writeProgress).toHaveBeenCalledTimes(1)
      expect(ctx.sonos.stop).toHaveBeenCalledTimes(1)
    })

    it('logs the streamer in lazily when no token is cached yet', async () => {
      ctx.streamer.currentToken.mockImplementation(() => {
        throw new Error('not logged in')
      })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      const [, plan] = ctx.sonos.startPlayback.mock.calls[0] as [string, { tracks: { url: string }[] }]
      expect(plan.tracks[0]?.url).toContain('token=refreshed-tok')
      expect(ctx.streamer.refresh).toHaveBeenCalled()
    })
  })

  describe('current', () => {
    it('reports the live absolute position and state', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      const session = await ctx.manager.current()
      // getPosition -> {trackIndex:1, relTimeSeconds:50} -> absolute 150.
      expect(session).toMatchObject({ state: 'playing', positionSeconds: 150 })
    })

    it('maps a device-side pause to state paused', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.sonos.getTransportState.mockResolvedValueOnce('PAUSED_PLAYBACK')
      expect((await ctx.manager.current()).state).toBe('paused')
    })

    it('throws when nothing is playing', async () => {
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })
  })

  describe('stop', () => {
    it('writes the final position back to ABS, stops Sonos, and clears the session', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      await ctx.manager.stop()

      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 150,
        durationSeconds: 300,
        isFinished: false,
      })
      expect(ctx.sonos.stop).toHaveBeenCalled()
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('marks the item finished when stopped within tolerance of the end', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      // Position near the end: track index 1, offset 199 -> absolute 299 (300 total, tol 3).
      ctx.sonos.getPosition.mockResolvedValueOnce({ trackIndex: 1, relTimeSeconds: 199 })
      await ctx.manager.stop()
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 300,
        durationSeconds: 300,
        isFinished: true,
      })
    })

    it('throws when nothing is playing', async () => {
      await expect(ctx.manager.stop()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('still writes progress and stops when the final position read fails', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.sonos.getPosition.mockRejectedValueOnce(new Error('sonos down'))
      await ctx.manager.stop()
      // Best effort: absolute falls back to 0 but we still record something and stop.
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 0,
        durationSeconds: 300,
        isFinished: false,
      })
      expect(ctx.sonos.stop).toHaveBeenCalled()
    })
  })
})
