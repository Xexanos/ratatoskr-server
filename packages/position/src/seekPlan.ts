// Pure seek planning (SPEC sections 4 and 13). Turns a target absolute book position into the
// ordered steps a Sonos coordinator must perform — "seek to the track, then to the in-track
// offset" — as a plain data structure. The settle delay, tolerance window and retry count are
// PARAMETERS carried on the plan, not read from the environment here: the sonos/ wrapper owns
// executing the steps and applying the tuning. No I/O (see purity.test.ts).

import { absoluteToTrack } from './positionMapper.js'

export interface SeekTuning {
  /** How long to wait after issuing a seek before trusting the reported position (ms). */
  settleMs: number
  /** How far the settled position may differ from the target before a retry (seconds). */
  toleranceSeconds: number
  /** How many times to re-issue the seek if the settled position is out of tolerance. */
  retries: number
}

/** One ordered step of a seek. `track` selects a queue entry (1-based); `time` seeks within it. */
export type SeekStep =
  | { readonly kind: 'track'; readonly trackNumber: number }
  | { readonly kind: 'time'; readonly offsetSeconds: number }

export interface SeekPlan {
  /** Zero-based index of the target track in the queue. */
  readonly trackIndex: number
  /** In-track offset to seek to, in seconds. */
  readonly offsetSeconds: number
  /** True when the target lay outside [0, total] and was clamped (see absoluteToTrack). */
  readonly clamped: boolean
  /** Ordered steps: select the track (1-based `trackNumber`), then seek to the offset. */
  readonly steps: readonly SeekStep[]
  /** Settle/tolerance/retry knobs the sonos/ wrapper applies while executing the steps. */
  readonly tuning: SeekTuning
}

function assertValidTuning(tuning: SeekTuning): void {
  const { settleMs, toleranceSeconds, retries } = tuning
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    throw new RangeError(`settleMs must be a non-negative, finite number (got ${settleMs})`)
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError(`toleranceSeconds must be a non-negative, finite number (got ${toleranceSeconds})`)
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries must be a non-negative integer (got ${retries})`)
  }
}

/**
 * Plan the ordered steps to reach `targetAbsoluteSeconds` in a book of the given per-track
 * durations. The track number is 1-based (Sonos queue positions start at 1); the offset is the
 * clamped in-track position from absoluteToTrack.
 */
export function planSeek(
  trackDurations: readonly number[],
  targetAbsoluteSeconds: number,
  tuning: SeekTuning,
): SeekPlan {
  assertValidTuning(tuning)
  const { trackIndex, offsetSeconds, clamped } = absoluteToTrack(trackDurations, targetAbsoluteSeconds)
  return {
    trackIndex,
    offsetSeconds,
    clamped,
    steps: [
      { kind: 'track', trackNumber: trackIndex + 1 },
      { kind: 'time', offsetSeconds },
    ],
    tuning,
  }
}
