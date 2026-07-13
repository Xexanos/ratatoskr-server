import type { components } from '@ratatoskr/contract'
import { planPlayback, planSeek, trackToAbsolute, type SeekTuning } from '@ratatoskr/position'
import type { AbsClient, PlaybackTrack, ProgressUpdate } from '../abs/client.js'
import type { Config } from '../config/index.js'
import type { SonosClient } from '../sonos/client.js'
import { NoActiveSessionError } from './errors.js'

type Session = components['schemas']['Session']
type PlaybackState = components['schemas']['PlaybackState']
type RotatedTokens = components['schemas']['RotatedTokens']

// How close to the end counts as "finished". Independent of the seek tuning (seekToleranceSeconds
// is about seek accuracy) so that raising the seek tolerance for a flaky speaker does not silently
// widen the end-of-book window.
const END_OF_BOOK_TOLERANCE_SECONDS = 5

export interface SessionManagerDeps {
  abs: AbsClient
  sonos: SonosClient
  config: Config
}

// The single active playback session, held in memory only (SPEC section 8: no session store; a
// restart loses the session but not progress, which lives in ABS).
interface ActiveSession {
  itemId: string
  speakerId: string
  // The listening user's tokens — used for ABS progress read/write so progress is per-user. Never
  // embedded in media URLs (those carry the streamer token). The sync loop renews both proactively
  // before the access token expires (SPEC section 8); refreshToken is undefined when the client did
  // not hand one to startSession, in which case no renewal happens.
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
  // A rotated ABS token pair the sync loop obtained for the listening user, awaiting delivery to the
  // client (SPEC section 8), plus the access token the owner still held when we rotated. The pair is
  // attached to a Session response ONLY for a caller presenting that pre-rotation token — so on a
  // multi-user ABS a different user polling the session can't receive the owner's refresh token — and
  // only until the client authenticates with the new access token (adoption). Both are discarded
  // whenever the session ends.
  private pendingRotatedTokens: RotatedTokens | undefined
  private preRotationToken: string | undefined

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

      const plan = planPlayback(
        manifest.tracks.map((track: PlaybackTrack) => ({
          url: this.mediaUrl(itemId, track.ino),
          mimeType: track.mimeType,
          durationSeconds: track.durationSeconds,
          // The book's title/author on every track, so the Sonos app shows the book (SPEC §4).
          title: manifest.title,
          author: manifest.author,
        })),
      )

      // Resume from the ABS-stored position (clamped into the book), stepped back a few seconds so
      // the listener re-orients (RESUME_REWIND_SECONDS — the podcast/audiobook convention, SPEC §5).
      // A *finished* book restarts from the beginning rather than seeking to the exact end (where
      // playback would end immediately).
      const stored = Math.min(Math.max(progress.positionSeconds, 0), manifest.totalDurationSeconds)
      const resumeSeconds = progress.isFinished ? 0 : Math.max(0, stored - this.deps.config.resumeRewindSeconds)

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
      // Fresh session baseline: `userToken` is the client's current access token, so any pending pair
      // from a previous session is stale.
      this.pendingRotatedTokens = undefined
      this.preRotationToken = undefined
      this.startLoop()
      return this.toSession(userToken, 'playing', resumeSeconds)
    })
  }

  // Pause playback and write the current position immediately (SPEC section 5). The sync loop keeps
  // running so a later resume — or a device-side action — is still reflected.
  async pause(callerToken: string): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      this.noteCaller(callerToken)
      await this.deps.sonos.pause(session.speakerId)
      const absolute = await this.readAbsolute(session)
      if (absolute !== undefined) await this.writeBack(session, absolute)
      return this.toSession(callerToken, 'paused', absolute ?? this.lastWrittenSeconds)
    })
  }

  // Resume playback on the existing queue.
  async resume(callerToken: string): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      this.noteCaller(callerToken)
      await this.deps.sonos.play(session.speakerId)
      const absolute = await this.readAbsolute(session)
      return this.toSession(callerToken, 'playing', absolute ?? this.lastWrittenSeconds)
    })
  }

  // Seek to an absolute book position and write it back immediately.
  async seek(callerToken: string, positionSeconds: number): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      this.noteCaller(callerToken)
      const target = Math.min(Math.max(positionSeconds, 0), session.totalDurationSeconds)
      await this.deps.sonos.seek(session.speakerId, planSeek([...session.trackDurations], target, this.seekTuning()))
      await this.writeBack(session, target)
      return this.toSession(callerToken, await this.readState(session), target)
    })
  }

  // The active session with a live position/state read from the coordinator (so a device-side pause
  // is already reflected here). Throws NoActiveSessionError (404) when nothing is playing.
  async current(callerToken: string): Promise<Session> {
    return this.serialize(async () => {
      const session = this.requireSession()
      this.noteCaller(callerToken)
      const { absolute, state } = await this.readLive(session)
      return this.toSession(callerToken, state, absolute)
    })
  }

  // Stop playback, writing the final position back to ABS. Throws NoActiveSessionError (404) if
  // nothing is playing. Returns a final Session (200) when a rotated token pair was still pending at
  // stop — the last chance to deliver it, since the tokens are discarded on stop (SPEC section 8) —
  // and undefined (204) otherwise. `callerToken` is optional so the onClose shutdown hook can stop
  // without a caller.
  async stop(callerToken?: string): Promise<Session | undefined> {
    return this.serialize(async () => {
      const session = this.requireSession()
      if (callerToken !== undefined) this.noteCaller(callerToken)
      // Only hand the pair back if this caller is the owner (same gate as toSession).
      const pending = callerToken !== undefined && this.shouldDeliverRotated(callerToken) ? this.pendingRotatedTokens : undefined
      const { itemId, speakerId, totalDurationSeconds } = session
      const reached = await this.stopInternal() // writes the final position, then clears the session
      if (pending === undefined) return undefined
      const position = reached ?? this.lastWrittenSeconds
      const finished = totalDurationSeconds - position <= END_OF_BOOK_TOLERANCE_SECONDS
      return {
        itemId,
        speakerId,
        state: finished ? 'finished' : 'stopped',
        positionSeconds: finished ? totalDurationSeconds : position,
        durationSeconds: totalDurationSeconds,
        updatedAt: new Date().toISOString(),
        rotatedTokens: pending,
      }
    })
  }

  // True while a session is active — used by the app's onClose hook to stop on shutdown.
  hasSession(): boolean {
    return this.session !== undefined
  }

  // Write the final position and tear down. Returns the reached absolute position when it was read
  // from our own queue (for the caller's final Session), or undefined when the read failed or the
  // speaker was on foreign content — in which case nothing is written either (writeProgress stores
  // exactly what it is given, so a fallback or foreign position would wipe the real stored position).
  private async stopInternal(): Promise<number | undefined> {
    const session = this.session
    if (session === undefined) return undefined
    let reached: number | undefined
    let write: ProgressUpdate | undefined
    try {
      const live = await this.readLive(session)
      if (this.isOurTrack(session, live.trackUri)) {
        reached = live.absolute
        write = this.progressAt(session, live.absolute)
      }
    } catch {
      reached = undefined
    }
    await this.finalize(session, write)
    return reached
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
    // The listening user's tokens are discarded on stop (SPEC section 8); a pair still pending here
    // was already handed back in stop()'s final Session (or is lost on shutdown, by design).
    this.pendingRotatedTokens = undefined
    this.preRotationToken = undefined
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

    // Renew the listening token first (independent of the Sonos read below), so a rotation is not
    // skipped by a transient speaker hiccup and the write-back/finalize that follow use a fresh token.
    await this.maybeRotateTokens(session)

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
    this.pendingRotatedTokens = undefined
    this.preRotationToken = undefined
  }

  // Adoption (SPEC section 8): once the client authenticates with the rotated access token, delivery
  // is confirmed and we stop redelivering the pair. The old access token stays valid until its own
  // expiry, so pre-adoption requests (carrying the old token) still match `validateToken` upstream.
  private noteCaller(callerToken: string): void {
    if (this.pendingRotatedTokens !== undefined && callerToken === this.pendingRotatedTokens.accessToken) {
      this.pendingRotatedTokens = undefined
    }
  }

  // Renew the listening user's ABS tokens proactively, before the access token expires, so the sync
  // loop's own writes keep working and the rotated pair can be handed to the client while its old
  // access token is still valid (SPEC section 8). Runs each tick; the network refresh only fires in
  // the margin before expiry. No-op without a stored refresh token, or when the access token carries
  // no decodable `exp` (older ABS / non-JWT) — then proactive renewal simply does not engage.
  private async maybeRotateTokens(session: ActiveSession): Promise<void> {
    // Rotate at most one pair ahead of the client: while a pair is still awaiting delivery/adoption,
    // don't rotate again. This bounds a mis-set margin (>= the token lifetime) to a single rotation
    // instead of one per tick, and keeps `preRotationToken` equal to the token the client still holds
    // (so the delivery gate can't be outrun by back-to-back rotations).
    if (this.pendingRotatedTokens !== undefined) return
    if (session.refreshToken === undefined) return
    const exp = jwtExpSeconds(session.listeningToken)
    if (exp === undefined) return
    if (Date.now() / 1000 < exp - this.deps.config.listeningTokenRefreshMarginSeconds) return
    try {
      const rotated = await this.deps.abs.refresh(session.refreshToken)
      this.preRotationToken = session.listeningToken // the token the owner still holds until it expires
      session.listeningToken = rotated.accessToken
      session.refreshToken = rotated.refreshToken
      this.pendingRotatedTokens = { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken }
    } catch {
      // best-effort: the refresh token may already be invalid; writes then fail and drop (as before
      // this handover), and the client re-logs-in. Never wedge the loop.
    }
  }

  // Write an in-progress position back to ABS (never `isFinished` — the book is not done until the
  // transport stops), best-effort, tracking it as the last written position. The THRESHOLD is
  // tracked on the true read position; only the persisted value is backed off (see persistedPosition).
  private async writeBack(session: ActiveSession, absolute: number): Promise<void> {
    try {
      await this.deps.abs.writeProgress(session.listeningToken, session.itemId, {
        currentTimeSeconds: this.persistedPosition(absolute),
        durationSeconds: session.totalDurationSeconds,
        isFinished: false,
      })
      this.lastWrittenSeconds = absolute
    } catch {
      // best-effort; the next tick retries
    }
  }

  // The position to persist to ABS: the read position minus WRITE_POSITION_BACKOFF_SECONDS, because
  // Sonos's reported RelTime runs slightly ahead of the audible output (buffering), so writing it
  // verbatim leaves ABS a touch ahead of what was actually heard (SPEC §5). Clamped at 0.
  private persistedPosition(absolute: number): number {
    return Math.max(0, absolute - this.deps.config.writePositionBackoffSeconds)
  }

  // The final progress payload for an absolute position — marks finished when within the end-of-book
  // window (independent of the seek tolerance). Used only on teardown, not for in-progress writes.
  // Finished writes the exact end; an unfinished one is backed off like every other persisted write.
  private progressAt(session: ActiveSession, absolute: number): ProgressUpdate {
    const isFinished = session.totalDurationSeconds - absolute <= END_OF_BOOK_TOLERANCE_SECONDS
    return {
      currentTimeSeconds: isFinished ? session.totalDurationSeconds : this.persistedPosition(absolute),
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

  private toSession(callerToken: string, state: PlaybackState, positionSeconds: number): Session {
    const session = this.requireSession()
    const result: Session = {
      itemId: session.itemId,
      speakerId: session.speakerId,
      state,
      positionSeconds,
      durationSeconds: session.totalDurationSeconds,
      updatedAt: new Date().toISOString(),
    }
    if (this.shouldDeliverRotated(callerToken)) result.rotatedTokens = this.pendingRotatedTokens
    return result
  }

  // Deliver a pending rotated pair (SPEC section 8) only to the caller presenting the pre-rotation
  // access token — the session owner, whose old token stays valid until its own expiry. Ties the
  // handover to the owner so a different valid ABS user can't collect it. Never logged: the server
  // does not log response bodies, and the request serializer strips the URL query (section 14).
  private shouldDeliverRotated(callerToken: string): boolean {
    return this.pendingRotatedTokens !== undefined && callerToken === this.preRotationToken
  }

  private requireSession(): ActiveSession {
    if (this.session === undefined) throw new NoActiveSessionError()
    return this.session
  }

  private seekTuning(): SeekTuning {
    return {
      settleMs: this.deps.config.seekSettleMs,
      toleranceSeconds: this.deps.config.seekToleranceSeconds,
      retries: this.deps.config.seekRetries,
    }
  }

  // The ABS raw-file stream URL for a track, carrying the streamer API key (SPEC section 14).
  private mediaUrl(itemId: string, ino: string): string {
    const base = this.deps.config.absUrl.replace(/\/$/, '')
    const key = this.deps.config.absStreamerApiKey
    return `${base}/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(ino)}?token=${encodeURIComponent(key)}`
  }
}

// Read a JWT's `exp` (seconds since the epoch) WITHOUT verifying the signature — only the timing is
// needed, to renew before expiry, and ABS is the authority on validity. Returns undefined for a
// non-JWT / unparseable token, so the caller degrades to "no proactive renewal".
function jwtExpSeconds(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
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
