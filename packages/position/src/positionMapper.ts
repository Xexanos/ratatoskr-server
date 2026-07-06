// Pure position mapping (SPEC section 4). Converts between an audiobook's absolute
// position — seconds from the start of the whole book, as Audiobookshelf stores progress —
// and a (trackIndex, in-track offset) pair, as Sonos reports and accepts, using the
// per-track durations from ABS. No I/O by design (SPEC section 13; see purity.test.ts).
//
// Conventions:
//   - Track boundaries are half-open: [start_i, start_{i+1}). A position exactly on a
//     boundary belongs to the *start of the next track* (offset 0).
//   - The exact end of the book (absoluteSeconds === total) maps to the last track at its
//     full duration and is NOT considered clamped.
//   - Track durations are a caller precondition: a malformed list (empty, non-finite, or
//     non-positive) throws (programmer error). Position *values* are never rejected —
//     out-of-range positions are clamped and flagged, so seeks can't crash the caller.

export interface TrackPosition {
  /** Zero-based index into the track-durations array. */
  trackIndex: number
  /** Seconds from the start of that track; always within [0, track duration]. */
  offsetSeconds: number
  /** True when the requested absolute position lay outside [0, total] and was clamped. */
  clamped: boolean
}

function assertValidDurations(trackDurations: readonly number[]): void {
  if (trackDurations.length === 0) {
    throw new RangeError('trackDurations must not be empty')
  }
  for (const [index, duration] of trackDurations.entries()) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new RangeError(`trackDurations[${index}] must be a positive, finite number (got ${duration})`)
    }
  }
}

/** Total playable length of the book, in seconds. */
export function totalDuration(trackDurations: readonly number[]): number {
  assertValidDurations(trackDurations)
  return trackDurations.reduce((sum, duration) => sum + duration, 0)
}

/** Map an absolute book position to a track index and in-track offset. */
export function absoluteToTrack(trackDurations: readonly number[], absoluteSeconds: number): TrackPosition {
  assertValidDurations(trackDurations)
  if (!Number.isFinite(absoluteSeconds)) {
    throw new RangeError(`absoluteSeconds must be finite (got ${absoluteSeconds})`)
  }

  if (absoluteSeconds <= 0) {
    return { trackIndex: 0, offsetSeconds: 0, clamped: absoluteSeconds < 0 }
  }

  let cumulativeStart = 0
  for (const [index, duration] of trackDurations.entries()) {
    const trackEnd = cumulativeStart + duration
    if (absoluteSeconds < trackEnd) {
      // offsetSeconds >= 0 here because absoluteSeconds >= cumulativeStart (all earlier
      // tracks were passed), so no negative offsets from floating-point drift at edges.
      return { trackIndex: index, offsetSeconds: absoluteSeconds - cumulativeStart, clamped: false }
    }
    cumulativeStart = trackEnd
  }

  // absoluteSeconds >= total: the exact end of the book, or beyond it (clamped).
  const lastIndex = trackDurations.length - 1
  return {
    trackIndex: lastIndex,
    offsetSeconds: trackDurations[lastIndex] as number, // safe: list is non-empty
    clamped: absoluteSeconds > cumulativeStart, // cumulativeStart === total here
  }
}

/** Map a track index and in-track offset back to an absolute book position. */
export function trackToAbsolute(
  trackDurations: readonly number[],
  trackIndex: number,
  offsetSeconds: number,
): number {
  assertValidDurations(trackDurations)
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= trackDurations.length) {
    throw new RangeError(`trackIndex ${trackIndex} out of range [0, ${trackDurations.length - 1}]`)
  }
  if (!Number.isFinite(offsetSeconds)) {
    throw new RangeError(`offsetSeconds must be finite (got ${offsetSeconds})`)
  }

  const precedingTotal = trackDurations.slice(0, trackIndex).reduce((sum, duration) => sum + duration, 0)
  const duration = trackDurations[trackIndex] as number // safe: range-checked above
  // Clamp the offset into the track; Sonos can momentarily report a value slightly past
  // the track's end.
  const clampedOffset = Math.min(Math.max(offsetSeconds, 0), duration)
  return precedingTotal + clampedOffset
}
