import type { components } from '@ratatoskr/contract'
import { planPlayback, planSeek, trackToAbsolute, type SeekTuning } from '@ratatoskr/position'
import type { AbsClient, PlaybackTrack, ProgressUpdate } from '../abs/client.js'
import type { StreamerSession } from '../abs/streamerSession.js'
import type { Config } from '../config/index.js'
import type { SonosClient } from '../sonos/client.js'
import { NoActiveSessionError } from './errors.js'

type Session = components['schemas']['Session']
type PlaybackState = components['schemas']['PlaybackState']

// How close to the end counts as "finished". Independent of the seek tuning (seekToleranceSeconds
// is about seek accuracy) so that raising the seek tolerance for a flaky speaker does not silently
// widen the end-of-book window.
const END_OF_BOOK_TOLERANCE_SECONDS = 5

export interface SessionManagerDeps {
  abs: AbsClient
  sonos: SonosClient
  streamer: StreamerSession
  config: Config
}

// The single active playback session, held in memory only (SPEC section 8: no session store; a
// restart loses the session but not progress, which lives in ABS).
interface ActiveSession {
  itemId: string
  speakerId: string
  // The listening user's token — used for ABS progress read/write so progress is per-user. Never
  // embedded in media URLs (those carry the streamer token). refreshToken is held for the phase-4
  // rotation handover (a later slice); unused in this slice.
  listeningToken: string
  refreshToken: string | undefined
  trackDurations: number[]
  totalDurationSeconds: number
  // The queue's media URLs, so the sync loop can tell our book from a LAN takeover (a household
  // member starting other content on the speaker) by comparing the coordinator's reported TrackURI.
  mediaUrls: string[]
}

// Owns the one in-memory session and drives ABS + Sonos to start / report / stop playback
// (SPEC sections 4 and 5). The sync loop and pause/resume/seek live in a later slice.
export class SessionManager {
  private session: ActiveSession | undefined
  // Fastify serves requests concurrently, and the operations below interleave `await`s around the
  // single `session` field. Chain start/stop/current through this promise so exactly one runs at a
  // time — otherwise concurrent starts orphan a playing speaker, or a start/stop race clears a
  // freshly-started session (GET/DELETE 404 while the speaker plays on).
  private opChain: Promise<unknown> = Promise.resolve()
  // The self-scheduling sync-loop timer, and the last absolute position written to ABS for the
  // current session, so the loop only writes once the position has moved by the threshold.
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private lastWrittenSeconds = 0
  // Bumped by every startLoop/stopLoop. A tick captures the generation it was scheduled under and
  // bails (won't run, won't reschedule) once it no longer matches — so a tick that fired just before
  // a replace-start()/stop can't spawn a second, orphaned poll chain.
  private loopGeneration = 0

  constructor(private readonly deps: SessionManagerDeps) {}

  // Start (or replace) playback: build the queue from ABS track metadata + the streamer token, play
  // it, and resume from the position stored in ABS. Throws ItemNotPlayableError (400) / AbsAuthError
  // (401) for a bad book or an invalid token — validated BEFORE any active session is touched.
  async start(userToken: string, refreshToken: string | undefined, itemId: string, speakerId: string): Promise<Session> {
    return this.serialize(async () => {
      // Validate the token and confirm the book is playable first: getPlaybackManifest presents the
      // token to ABS (401s an invalid one) and rejects an unplayable book. Only after this is known
      // viable do we tear down any active session — so a bad/unauthenticated request, or an
      // unplayable itemId, no longer kills what is currently playing.
      const [manifest, progress] = await Promise.all([
        this.deps.abs.getPlaybackManifest(userToken, itemId),
        this.deps.abs.getProgress(userToken, itemId),
      ])

      const streamerToken = await this.ensureStreamerToken()
      const plan = planPlayback(
        manifest.tracks.map((track: PlaybackTrack) => ({
          url: this.mediaUrl(itemId, track.ino, streamerToken),
          mimeType: track.mimeType,
          durationSeconds: track.durationSeconds,
        })),
      )

      // Resume from the ABS-stored position (clamped into the book). A *finished* book restarts from
      // the beginning rather than seeking to the exact end (where playback would end immediately).
      const resumeSeconds = progress.isFinished
        ? 0
        : Math.min(Math.max(progress.positionSeconds, 0), manifest.totalDurationSeconds)

      // Now that the new start is viable, replace any active session (writing its final position).
      if (this.session !== undefined) {
        await this.stopInternal()
      }

      await this.deps.sonos.startPlayback(speakerId, plan)
      if (resumeSeconds > 0) {
        await this.deps.sonos.seek(speakerId, planSeek([...plan.trackDurations], resumeSeconds, this.seekTuning()))
      }

      this.session = {
        itemId,
        speakerId,
        listeningToken: userToken,
        refreshToken,
        trackDurations: [...plan.trackDurations],
        totalDurationSeconds: plan.totalDurationSeconds,
        mediaUrls: plan.tracks.map((track) => track.url),
      }
      this.lastWrittenSeconds = resumeSeconds
      this.startLoop()
      return this.toSession('playing', resumeSeconds)
    })
  }

  // Pause playback and write the current position immediately (SPEC section 5). The sync loop keeps
  // running so a later resume — or a device-side action — is still reflected.
  async pause(): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      await this.deps.sonos.pause(session.speakerId)
      const absolute = await this.readAbsolute(session)
      if (absolute !== undefined) await this.writeBack(session, absolute)
      return this.toSession('paused', absolute ?? this.lastWrittenSeconds)
    })
  }

  // Resume playback on the existing queue.
  async resume(): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      await this.deps.sonos.play(session.speakerId)
      const absolute = await this.readAbsolute(session)
      return this.toSession('playing', absolute ?? this.lastWrittenSeconds)
    })
  }

  // Seek to an absolute book position and write it back immediately.
  async seek(positionSeconds: number): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      const target = Math.min(Math.max(positionSeconds, 0), session.totalDurationSeconds)
      await this.deps.sonos.seek(session.speakerId, planSeek([...session.trackDurations], target, this.seekTuning()))
      await this.writeBack(session, target)
      return this.toSession(await this.readState(session), target)
    })
  }

  // The active session with a live position/state read from the coordinator (so a device-side pause
  // is already reflected here). Throws NoActiveSessionError (404) when nothing is playing.
  async current(): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      const { absolute, state } = await this.readLive(session)
      return this.toSession(state, absolute)
    })
  }

  // Stop playback, writing the final position back to ABS. Throws NoActiveSessionError (404) if
  // nothing is playing.
  async stop(): Promise<void> {
    return this.serialize(async () => {
      this.requireSession()
      await this.stopInternal()
    })
  }

  // True while a session is active — used by the app's onClose hook to stop on shutdown.
  hasSession(): boolean {
    return this.session !== undefined
  }

  private async stopInternal(): Promise<void> {
    const session = this.session
    if (session === undefined) return
    // Read the reached position. Skip the write if the read FAILS or the speaker is on foreign
    // content: writeProgress stores exactly what it is given, so writing a fallback or a foreign
    // position would wipe the user's real stored position (e.g. speaker unplugged 20h into a book,
    // or a LAN takeover). Only persist a position we actually read from our own queue.
    let write: ProgressUpdate | undefined
    try {
      const live = await this.readLive(session)
      write = this.isOurTrack(session, live.trackUri) ? this.progressAt(session, live.absolute) : undefined
    } catch {
      write = undefined
    }
    await this.finalize(session, write)
  }

  // Write the given payload (best-effort), cancel the sync loop, stop the speaker, and clear the
  // session. Shared by stop(), the replace path in start(), and the loop's end/device-stop handling.
  // A failed write (e.g. the ~1h listening token expiring mid-book — renewal via the stored
  // refreshToken lands with the rotation slice) must not block the teardown.
  private async finalize(session: ActiveSession, write: ProgressUpdate | undefined): Promise<void> {
    this.stopLoop()
    if (write !== undefined) {
      try {
        await this.deps.abs.writeProgress(session.listeningToken, session.itemId, write)
      } catch {
        // best-effort
      }
    }
    try {
      await this.deps.sonos.stop(session.speakerId)
    } catch {
      // best effort — the session is ending regardless
    }
    this.session = undefined
  }

  // --- Sync loop (SPEC section 5): poll the coordinator, write progress back on movement, and
  // finalize on end-of-book or a device-side stop. One tick at a time through the same mutex as the
  // user operations, so it never races a pause/seek/stop.

  private startLoop(): void {
    this.stopLoop() // bumps the generation and clears any pending timer
    this.scheduleTick(this.loopGeneration)
  }

  private scheduleTick(generation: number): void {
    this.syncTimer = setTimeout(() => void this.tick(generation), this.deps.config.pollIntervalSeconds * 1000)
    // Don't keep the process alive solely for the poll timer; shutdown stops the session explicitly.
    this.syncTimer.unref?.()
  }

  private async tick(generation: number): Promise<void> {
    // A tick from a superseded loop (its timer fired just before a replace-start()/stop) must not
    // run or reschedule — otherwise it would spawn a second, orphaned poll chain.
    if (generation !== this.loopGeneration) return
    await this.serialize(() => this.syncOnce()).catch(() => undefined)
    // Reschedule only while this is still the current loop and a session is active (syncOnce may
    // have finalized it).
    if (generation === this.loopGeneration && this.session !== undefined) this.scheduleTick(generation)
  }

  private async syncOnce(): Promise<void> {
    const session = this.session
    if (session === undefined) return

    let live: { absolute: number; state: PlaybackState; trackUri: string }
    try {
      live = await this.readLive(session)
    } catch {
      return // transient read failure — try again next tick
    }

    // The coordinator is playing something that isn't our queue — a household member started other
    // content on the speaker (Sonos app, radio alarm, voice). Relinquish the session rather than
    // recording the foreign position as book progress (see relinquish). A cleared queue also lands
    // here (empty TrackURI), which is what stops the `Track 0 / RelTime 0 / STOPPED` zero-write wipe.
    if (!this.isOurTrack(session, live.trackUri)) {
      this.relinquish()
      return
    }

    // A stopped transport ends the session: near the end it's a finished book (progressAt marks it),
    // otherwise a device-side stop mid-book. Either way write the reached position and tear down.
    if (live.state === 'stopped') {
      await this.finalize(session, this.progressAt(session, live.absolute))
      return
    }

    // Otherwise (playing or paused) write back once the position has moved past the threshold. A
    // device-side pause is captured here too, but only if it had already drifted a threshold from
    // the last write; a pause within the threshold is persisted later (on resume-drift or stop).
    // That satisfies SPEC §5, which mandates the immediate write only for our own pause endpoint.
    if (Math.abs(live.absolute - this.lastWrittenSeconds) >= this.deps.config.progressWriteThresholdSeconds) {
      await this.writeBack(session, live.absolute)
    }
  }

  // Does the coordinator's reported TrackURI belong to this session's queue? Compared without the
  // query string so a re-issued media URL (streamer token refreshed in a later slice) still matches;
  // an empty URI (cleared queue) is never ours.
  private isOurTrack(session: ActiveSession, trackUri: string): boolean {
    if (trackUri === '') return false
    const withoutQuery = (url: string): string => {
      const q = url.indexOf('?')
      return q === -1 ? url : url.slice(0, q)
    }
    const target = withoutQuery(trackUri)
    return session.mediaUrls.some((url) => withoutQuery(url) === target)
  }

  private stopLoop(): void {
    // Invalidate any already-fired tick still queued behind the mutex, then drop the pending timer.
    this.loopGeneration += 1
    if (this.syncTimer !== undefined) {
      clearTimeout(this.syncTimer)
      this.syncTimer = undefined
    }
  }

  // Give up the session WITHOUT writing progress or stopping the speaker — used when the coordinator
  // is playing content that isn't ours (a LAN takeover). Writing would corrupt the book's progress
  // with a foreign position; stopping would cut off whatever the household member just started. ABS
  // keeps the last position we wrote.
  private relinquish(): void {
    this.stopLoop()
    this.session = undefined
  }

  // Write an in-progress position back to ABS (never `isFinished` — the book is not done until the
  // transport stops), best-effort, tracking it as the last written position.
  private async writeBack(session: ActiveSession, absolute: number): Promise<void> {
    try {
      await this.deps.abs.writeProgress(session.listeningToken, session.itemId, {
        currentTimeSeconds: absolute,
        durationSeconds: session.totalDurationSeconds,
        isFinished: false,
      })
      this.lastWrittenSeconds = absolute
    } catch {
      // best-effort; the next tick retries
    }
  }

  // The final progress payload for an absolute position — marks finished when within the end-of-book
  // window (independent of the seek tolerance). Used only on teardown, not for in-progress writes.
  private progressAt(session: ActiveSession, absolute: number): ProgressUpdate {
    const isFinished = session.totalDurationSeconds - absolute <= END_OF_BOOK_TOLERANCE_SECONDS
    return {
      currentTimeSeconds: isFinished ? session.totalDurationSeconds : absolute,
      durationSeconds: session.totalDurationSeconds,
      isFinished,
    }
  }

  // One live read of the coordinator — position (as absolute seconds), transport state, and the
  // playing track's URI — shared by current/syncOnce/stopInternal/pause/resume/seek. The CALLER
  // decides the catch policy: current() propagates (a GET should surface a dead speaker), the loop
  // and stopInternal swallow-and-skip, pause/resume/seek fall back to the last written position.
  private async readLive(session: ActiveSession): Promise<{ absolute: number; state: PlaybackState; trackUri: string }> {
    const [position, transportState] = await Promise.all([
      this.deps.sonos.getPosition(session.speakerId),
      this.deps.sonos.getTransportState(session.speakerId),
    ])
    return {
      absolute: this.toAbsolute(session, position.trackIndex, position.relTimeSeconds),
      state: mapTransportState(transportState),
      trackUri: position.trackUri,
    }
  }

  private async readAbsolute(session: ActiveSession): Promise<number | undefined> {
    try {
      return (await this.readLive(session)).absolute
    } catch {
      return undefined
    }
  }

  private async readState(session: ActiveSession): Promise<PlaybackState> {
    try {
      return (await this.readLive(session)).state
    } catch {
      return 'playing'
    }
  }

  // Run session operations one at a time (see opChain). The chain continues regardless of an op's
  // outcome so one failure does not wedge the manager.
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = this.opChain.then(op, op)
    this.opChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private toAbsolute(session: ActiveSession, trackIndex: number, relTimeSeconds: number): number {
    const boundedIndex = Math.min(Math.max(trackIndex, 0), session.trackDurations.length - 1)
    return trackToAbsolute(session.trackDurations, boundedIndex, relTimeSeconds)
  }

  private toSession(state: PlaybackState, positionSeconds: number): Session {
    const session = this.requireSession()
    return {
      itemId: session.itemId,
      speakerId: session.speakerId,
      state,
      positionSeconds,
      durationSeconds: session.totalDurationSeconds,
      updatedAt: new Date().toISOString(),
    }
  }

  private requireSession(): ActiveSession {
    if (this.session === undefined) throw new NoActiveSessionError()
    return this.session
  }

  // The streamer token for media URLs, logging in lazily if the startup login didn't happen or the
  // token has expired (a full re-login is fine — dedicated account, short-lived token).
  private async ensureStreamerToken(): Promise<string> {
    try {
      return this.deps.streamer.currentToken()
    } catch {
      return this.deps.streamer.refresh()
    }
  }

  private seekTuning(): SeekTuning {
    return {
      settleMs: this.deps.config.seekSettleMs,
      toleranceSeconds: this.deps.config.seekToleranceSeconds,
      retries: this.deps.config.seekRetries,
    }
  }

  // The ABS raw-file stream URL for a track, carrying the streamer token (SPEC section 14).
  private mediaUrl(itemId: string, ino: string, streamerToken: string): string {
    const base = this.deps.config.absUrl.replace(/\/$/, '')
    return `${base}/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(ino)}?token=${encodeURIComponent(streamerToken)}`
  }
}

function mapTransportState(state: string): PlaybackState {
  switch (state) {
    case 'PLAYING':
      return 'playing'
    case 'PAUSED_PLAYBACK':
      return 'paused'
    case 'TRANSITIONING':
      return 'buffering'
    default:
      return 'stopped'
  }
}
