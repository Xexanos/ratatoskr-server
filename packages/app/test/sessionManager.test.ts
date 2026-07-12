import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// A promise whose resolution the test controls — to hold an operation mid-flight (holding the
// session mutex) while a timer fires behind it.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

// A TrackURI the coordinator reports that belongs to our queue (matches a session media URL). The
// foreign-content guard compares TrackURI against the session's URLs, so the getPosition mocks must
// report one of ours or the sync loop treats the speaker as taken over.
const OUR_TRACK_URI = 'http://abs.invalid/api/items/li_1/file/20?token=streamer-tok'

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
    pause: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    getPosition: vi.fn().mockResolvedValue({ trackIndex: 1, relTimeSeconds: 50, trackUri: OUR_TRACK_URI }),
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
    pollIntervalSeconds: 10,
    progressWriteThresholdSeconds: 5,
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
      ctx.sonos.getPosition.mockResolvedValueOnce({ trackIndex: 1, relTimeSeconds: 199, trackUri: OUR_TRACK_URI })
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

  describe('pause / resume / seek', () => {
    it('pauses, writes the current position immediately, and reports paused', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      const session = await ctx.manager.pause()
      expect(ctx.sonos.pause).toHaveBeenCalledWith('RINCON_1')
      // getPosition -> {trackIndex:1, relTimeSeconds:50} -> absolute 150
      expect(session).toMatchObject({ state: 'paused', positionSeconds: 150 })
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 150,
        durationSeconds: 300,
        isFinished: false,
      })
    })

    it('resumes and reports playing', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      const session = await ctx.manager.resume()
      expect(ctx.sonos.play).toHaveBeenCalledWith('RINCON_1')
      expect(session.state).toBe('playing')
    })

    it('seeks to the target and writes it back', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      const session = await ctx.manager.seek(220)
      // 220 into [100,200] -> track index 1, offset 120
      const [, seekPlan] = ctx.sonos.seek.mock.calls.at(-1) as [string, { trackIndex: number; offsetSeconds: number }]
      expect(seekPlan).toMatchObject({ trackIndex: 1, offsetSeconds: 120 })
      expect(session.positionSeconds).toBe(220)
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 220,
        durationSeconds: 300,
        isFinished: false,
      })
    })

    it('clamps a seek beyond the end into the book', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      expect((await ctx.manager.seek(99999)).positionSeconds).toBe(300)
    })

    it('throw when nothing is playing', async () => {
      await expect(ctx.manager.pause()).rejects.toBeInstanceOf(NoActiveSessionError)
      await expect(ctx.manager.resume()).rejects.toBeInstanceOf(NoActiveSessionError)
      await expect(ctx.manager.seek(10)).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('pauses using the last written position (and writes nothing) when the live read fails', async () => {
      ctx = build({ positionSeconds: 42 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1') // lastWritten = 42
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockRejectedValueOnce(new Error('speaker blip'))
      const session = await ctx.manager.pause()
      expect(ctx.sonos.pause).toHaveBeenCalled()
      expect(session).toMatchObject({ state: 'paused', positionSeconds: 42 })
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled() // no position read -> nothing to persist
    })

    it('reports playing after a seek when the transport-state read fails', async () => {
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.sonos.getTransportState.mockRejectedValueOnce(new Error('blip'))
      expect((await ctx.manager.seek(120)).state).toBe('playing')
    })
  })

  describe('sync loop', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('writes progress back once the position moves past the threshold', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 0, relTimeSeconds: 80, trackUri: OUR_TRACK_URI }) // absolute 80
      await vi.advanceTimersByTimeAsync(10_000) // one poll interval
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 80,
        durationSeconds: 300,
        isFinished: false,
      })
    })

    it('does not write when the position has not moved past the threshold', async () => {
      ctx = build({ positionSeconds: 100 }) // lastWritten starts at 100
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 1, relTimeSeconds: 2, trackUri: OUR_TRACK_URI }) // absolute 102, moved 2 < 5
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
    })

    it('marks finished and tears down when the transport stops near the end', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 1, relTimeSeconds: 200, trackUri: OUR_TRACK_URI }) // absolute 300 (end)
      ctx.sonos.getTransportState.mockResolvedValue('STOPPED')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 300,
        durationSeconds: 300,
        isFinished: true,
      })
      expect(ctx.sonos.stop).toHaveBeenCalled()
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('tears down without finishing on a device-side stop mid-book', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 0, relTimeSeconds: 50, trackUri: OUR_TRACK_URI }) // absolute 50 (mid-book)
      ctx.sonos.getTransportState.mockResolvedValue('STOPPED')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.abs.writeProgress).toHaveBeenCalledWith('user-tok', 'li_1', {
        currentTimeSeconds: 50,
        durationSeconds: 300,
        isFinished: false,
      })
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('relinquishes without writing or stopping when the speaker is taken over (foreign track)', async () => {
      ctx = build({ positionSeconds: 100 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.stop.mockClear()
      // A household member started a radio on the speaker: the transport reports a foreign URI. Even
      // the zero-write worst case (Track 0 / STOPPED) must not wipe the stored position.
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 0, relTimeSeconds: 0, trackUri: 'x-sonosapi-stream:radio' })
      ctx.sonos.getTransportState.mockResolvedValue('STOPPED')
      await vi.advanceTimersByTimeAsync(10_000)
      // Neither a (foreign/zero) progress write nor a Stop of the foreign content — just relinquish.
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
      expect(ctx.sonos.stop).not.toHaveBeenCalled()
      await expect(ctx.manager.current()).rejects.toBeInstanceOf(NoActiveSessionError)
    })

    it('skips a tick without writing (keeping the session) when the coordinator read fails', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.getPosition.mockRejectedValue(new Error('unreachable'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
      expect(ctx.manager.hasSession()).toBe(true) // transient failure — try again next tick
    })

    it('relinquishes without wiping when the queue is cleared (empty TrackURI, STOPPED)', async () => {
      ctx = build({ positionSeconds: 100 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      ctx.sonos.stop.mockClear()
      // The exact zero-write worst case: a cleared queue reports Track 0 / RelTime 0 / STOPPED. The
      // empty TrackURI marks it as not-ours, so we relinquish instead of writing currentTime 0.
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 0, relTimeSeconds: 0, trackUri: '' })
      ctx.sonos.getTransportState.mockResolvedValue('STOPPED')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.abs.writeProgress).not.toHaveBeenCalled()
      expect(ctx.sonos.stop).not.toHaveBeenCalled()
      expect(ctx.manager.hasSession()).toBe(false)
    })

    it('retries a failed write-back on the next tick (lastWrittenSeconds does not advance on failure)', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1')
      ctx.abs.writeProgress.mockClear()
      // Position moved to 80 (past the 5s threshold). The first write fails, the second succeeds.
      ctx.sonos.getPosition.mockResolvedValue({ trackIndex: 0, relTimeSeconds: 80, trackUri: OUR_TRACK_URI })
      ctx.abs.writeProgress.mockRejectedValueOnce(new Error('ABS blip'))
      await vi.advanceTimersByTimeAsync(10_000) // tick 1: write rejected -> lastWrittenSeconds stays 0
      await vi.advanceTimersByTimeAsync(10_000) // tick 2: still 80s from 0 -> retried
      const writes = ctx.abs.writeProgress.mock.calls.filter(
        ([, , update]) => (update as { currentTimeSeconds: number }).currentTimeSeconds === 80,
      )
      expect(writes.length).toBe(2)
    })

    it('a tick that fires while a replace-start() is in flight does not spawn a second poll chain', async () => {
      ctx = build({ positionSeconds: 0 })
      await ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_1') // loop L1, timer T1 pending

      // Hold the replacing start() mid-flight (mutex held on getPlaybackManifest) so L1's timer fires
      // and queues its tick BEHIND the running start — the exact interleaving that used to orphan a
      // timer and leave two self-perpetuating poll chains.
      const manifestGate = deferred<PlaybackManifest>()
      ctx.abs.getPlaybackManifest.mockReturnValueOnce(manifestGate.promise)
      const replacing = ctx.manager.start('user-tok', undefined, 'li_1', 'RINCON_2')
      await vi.advanceTimersByTimeAsync(10_000) // T1 fires; its tick's syncOnce waits behind the hung start
      manifestGate.resolve(MANIFEST) // let the replace finish: it tears down L1 and starts L2
      await replacing
      await vi.advanceTimersByTimeAsync(1) // drain the superseded tick (which must NOT reschedule)

      ctx.sonos.getPosition.mockClear()
      await vi.advanceTimersByTimeAsync(10_000) // exactly one live loop -> one poll, not two in lockstep
      expect(ctx.sonos.getPosition).toHaveBeenCalledTimes(1)
    })
  })
})
