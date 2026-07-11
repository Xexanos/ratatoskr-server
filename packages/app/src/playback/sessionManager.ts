import type { components } from '@ratatoskr/contract'
import { planPlayback, planSeek, trackToAbsolute, type SeekTuning } from '@ratatoskr/position'
import type { AbsClient, PlaybackTrack } from '../abs/client.js'
import type { StreamerSession } from '../abs/streamerSession.js'
import type { Config } from '../config/index.js'
import type { SonosClient } from '../sonos/client.js'
import { NoActiveSessionError } from './errors.js'

type Session = components['schemas']['Session']
type PlaybackState = components['schemas']['PlaybackState']

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
}

// Owns the one in-memory session and drives ABS + Sonos to start / report / stop playback
// (SPEC sections 4 and 5). The sync loop and pause/resume/seek live in a later slice.
export class SessionManager {
  private session: ActiveSession | undefined

  constructor(private readonly deps: SessionManagerDeps) {}

  // Start (or replace) playback: build the queue from ABS track metadata + the streamer token,
  // play it, and resume from the position stored in ABS. Replacing an active session stops it
  // first (writing its final position). Throws ItemNotPlayableError (400) for bad book metadata.
  async start(userToken: string, refreshToken: string | undefined, itemId: string, speakerId: string): Promise<Session> {
    if (this.session !== undefined) {
      await this.stopInternal()
    }

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

    await this.deps.sonos.startPlayback(speakerId, plan)

    // Resume from the ABS-stored position (clamped into the book), seeking only when past the start.
    const resumeSeconds = Math.min(Math.max(progress.positionSeconds, 0), manifest.totalDurationSeconds)
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
    }
    return this.toSession('playing', resumeSeconds)
  }

  // The active session with a live position/state read from the coordinator (so a device-side
  // pause is already reflected here). Throws NoActiveSessionError (404) when nothing is playing.
  async current(): Promise<Session> {
    const session = this.requireSession()
    const [position, transportState] = await Promise.all([
      this.deps.sonos.getPosition(session.speakerId),
      this.deps.sonos.getTransportState(session.speakerId),
    ])
    const absolute = this.toAbsolute(session, position.trackIndex, position.relTimeSeconds)
    return this.toSession(mapTransportState(transportState), absolute)
  }

  // Stop playback, writing the final position back to ABS. Throws NoActiveSessionError (404) if
  // nothing is playing.
  async stop(): Promise<void> {
    this.requireSession()
    await this.stopInternal()
  }

  // True while a session is active — used by the app's onClose hook to stop on shutdown.
  hasSession(): boolean {
    return this.session !== undefined
  }

  private async stopInternal(): Promise<void> {
    const session = this.session
    if (session === undefined) return
    // Read the reached position (best effort — a failed read still stops and writes what we have).
    let absolute = 0
    try {
      const position = await this.deps.sonos.getPosition(session.speakerId)
      absolute = this.toAbsolute(session, position.trackIndex, position.relTimeSeconds)
    } catch {
      // keep absolute = 0; the write below still records something rather than nothing
    }
    const isFinished = session.totalDurationSeconds - absolute <= this.deps.config.seekToleranceSeconds
    await this.deps.abs.writeProgress(session.listeningToken, session.itemId, {
      currentTimeSeconds: isFinished ? session.totalDurationSeconds : absolute,
      durationSeconds: session.totalDurationSeconds,
      isFinished,
    })
    try {
      await this.deps.sonos.stop(session.speakerId)
    } catch {
      // best effort — the session is ending regardless
    }
    this.session = undefined
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

  // The streamer token for media URLs, logging in lazily if the startup login didn't happen or
  // the token has expired (a full re-login is fine — dedicated account, short-lived token).
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
