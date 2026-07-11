import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient, PlaybackManifest } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
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

function build(overrides: { positionSeconds?: number; isFinished?: boolean } = {}) {
  const abs = {
    getPlaybackManifest: vi.fn().mockResolvedValue(MANIFEST),
    getProgress: vi
      .fn()
      .mockResolvedValue({ positionSeconds: overrides.positionSeconds ?? 150, isFinished: overrides.isFinished ?? false }),
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

    it('restarts a finished book from the beginning instead of seeking to the end', async () => {
      // A finished book's stored position is the total; naively resuming would seek to the very end.
      ctx = build({ positionSeconds: 300, isFinished: true })
      const session = await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      expect(session.positionSeconds).toBe(0)
      expect(ctx.sonos.seek).not.toHaveBeenCalled()
    })

    it('leaves the active session untouched when a replacing start is rejected upstream', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.stop.mockClear()
      // The new start's token is invalid: getPlaybackManifest rejects before any teardown.
      ctx.abs.getPlaybackManifest.mockRejectedValueOnce(new AbsAuthError())
      await expect(ctx.manager.start('bad-tok', undefined, 'li_2', 'RINCON_2')).rejects.toBeInstanceOf(AbsAuthError)
      // The original session is preserved — not stopped, not overwritten, still current.
      expect(ctx.sonos.stop).not.toHaveBeenCalled()
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
      expect((await ctx.manager.current()).itemId).toBe('li_1')
    })

    it('serializes concurrent starts so the single-session invariant holds', async () => {
      const [, second] = await Promise.all([
        ctx.manager.start('t', undefined, 'li_1', 'RINCON_1'),
        ctx.manager.start('t', undefined, 'li_2', 'RINCON_2'),
      ])
      // Serialized: both played, and the second replaced the first (one stop+write) rather than
      // both starting with no session tracking one of the speakers.
      expect(ctx.sonos.startPlayback).toHaveBeenCalledTimes(2)
      expect(ctx.sonos.stop).toHaveBeenCalledTimes(1)
      expect(second.itemId).toBe('li_2')
      expect((await ctx.manager.current()).itemId).toBe('li_2')
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
      // Near the end: track index 1, offset 199 -> absolute 299 (300 total, within the 5s window).
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

    it('does NOT write on a failed position read (would wipe stored progress) but still stops', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.sonos.getPosition.mockRejectedValueOnce(new Error('sonos down'))
      await ctx.manager.stop()
      // No write — writing a fallback 0 would overwrite the user's real stored position.
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
      // But the speaker is still stopped and the session cleared.
      expect(ctx.sonos.stop).toHaveBeenCalled()
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('does not let a failed ABS write block the stop or leave the session stuck', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      // e.g. the listening token expired mid-book -> writeProgress rejects.
      ctx.abs.writeProgress.mockRejectedValueOnce(new AbsAuthError())
      await ctx.manager.stop() // must not throw
      expect(ctx.sonos.stop).toHaveBeenCalled()
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })
  })
})
