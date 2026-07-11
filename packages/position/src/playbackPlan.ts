// Pure playback planning (SPEC sections 4 and 13). Turns the per-track metadata of a book into
// the ordered queue Sonos should play — the track URLs (already carrying the streamer token,
// built by the caller so this module stays free of ABS/token concerns), their mime types, and
// the per-track durations the position/seek modules need. The DIDL-Lite *data* is just each
// track's {title, mimeType, url}; building the XML string lives in sonos/ (SPEC §13: position
// decides *what*, the sonos wrapper carries it out). No I/O (see purity.test.ts).

import { totalDuration } from './positionMapper.js'

export interface TrackInput {
  /** Fully-built stream URL for the track (including any access token). */
  url: string
  /** Mime type from ABS audio-file metadata, e.g. audio/mpeg, audio/mp4, audio/flac. */
  mimeType: string
  /** Track length in seconds, from ABS (Sonos's own TrackDuration is unreliable — SPEC §4). */
  durationSeconds: number
  /** Optional display title; defaults to "Track N". */
  title?: string
}

export interface PlannedTrack {
  readonly url: string
  readonly mimeType: string
  readonly durationSeconds: number
  readonly title: string
}

export interface PlaybackPlan {
  /** The ordered queue to enqueue on the coordinator. */
  readonly tracks: readonly PlannedTrack[]
  /** Per-track durations, in queue order — feed straight to the position/seek modules. */
  readonly trackDurations: readonly number[]
  /** Total playable length of the book, in seconds. */
  readonly totalDurationSeconds: number
}

/**
 * Build the queue plan for a book. Throws (programmer/precondition error) on an empty track list,
 * a track missing its url/mimeType, or a non-positive/non-finite duration — the abs/ layer is
 * responsible for surfacing a clean "cannot be played" error before reaching here (SPEC §4).
 */
export function planPlayback(tracks: readonly TrackInput[]): PlaybackPlan {
  if (tracks.length === 0) {
    throw new RangeError('playback plan needs at least one track')
  }
  tracks.forEach((track, index) => {
    if (typeof track.url !== 'string' || track.url === '') {
      throw new RangeError(`tracks[${index}].url must be a non-empty string`)
    }
    if (typeof track.mimeType !== 'string' || track.mimeType === '') {
      throw new RangeError(`tracks[${index}].mimeType must be a non-empty string`)
    }
  })

  const trackDurations = tracks.map((track) => track.durationSeconds)
  // Validates the durations (non-empty, positive, finite) and computes the total in one place.
  const totalDurationSeconds = totalDuration(trackDurations)

  const planned: PlannedTrack[] = tracks.map((track, index) => ({
    url: track.url,
    mimeType: track.mimeType,
    durationSeconds: track.durationSeconds,
    title: track.title !== undefined && track.title.trim() !== '' ? track.title : `Track ${index + 1}`,
  }))

  return { tracks: planned, trackDurations, totalDurationSeconds }
}
