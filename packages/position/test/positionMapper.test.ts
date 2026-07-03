import { describe, expect, it } from 'vitest'
import { absoluteToTrack, totalDuration, trackToAbsolute } from '../src/index.js'

// Test matrix mandated by SPEC section 9: single-file books, multi-file books, seeking
// across a track boundary, the start and the very end of a book, and rounding at edges.

describe('totalDuration', () => {
  it('sums the track durations', () => {
    expect(totalDuration([300])).toBe(300)
    expect(totalDuration([300, 600, 120])).toBe(1020)
  })
})

describe('absoluteToTrack', () => {
  describe('single-file book', () => {
    const book = [300]
    it('maps the start', () => {
      expect(absoluteToTrack(book, 0)).toEqual({ trackIndex: 0, offsetSeconds: 0, clamped: false })
    })
    it('maps a mid position', () => {
      expect(absoluteToTrack(book, 150)).toEqual({ trackIndex: 0, offsetSeconds: 150, clamped: false })
    })
    it('maps the exact end to the last track at full duration, not clamped', () => {
      expect(absoluteToTrack(book, 300)).toEqual({ trackIndex: 0, offsetSeconds: 300, clamped: false })
    })
  })

  describe('multi-file book', () => {
    const book = [300, 600, 120] // boundaries at 300 and 900, total 1020

    it('maps the start', () => {
      expect(absoluteToTrack(book, 0)).toEqual({ trackIndex: 0, offsetSeconds: 0, clamped: false })
    })

    it('maps just before a boundary to the end region of the earlier track', () => {
      expect(absoluteToTrack(book, 299)).toEqual({ trackIndex: 0, offsetSeconds: 299, clamped: false })
    })

    it('maps a position exactly on a boundary to the start of the next track', () => {
      expect(absoluteToTrack(book, 300)).toEqual({ trackIndex: 1, offsetSeconds: 0, clamped: false })
      expect(absoluteToTrack(book, 900)).toEqual({ trackIndex: 2, offsetSeconds: 0, clamped: false })
    })

    it('maps a mid position within a later track (seek across a boundary)', () => {
      expect(absoluteToTrack(book, 350)).toEqual({ trackIndex: 1, offsetSeconds: 50, clamped: false })
      expect(absoluteToTrack(book, 950)).toEqual({ trackIndex: 2, offsetSeconds: 50, clamped: false })
    })

    it('maps the very end of the book', () => {
      expect(absoluteToTrack(book, 1020)).toEqual({ trackIndex: 2, offsetSeconds: 120, clamped: false })
    })
  })

  describe('clamping out-of-range positions', () => {
    const book = [300, 600]
    it('clamps a negative position to the start and flags it', () => {
      expect(absoluteToTrack(book, -5)).toEqual({ trackIndex: 0, offsetSeconds: 0, clamped: true })
    })
    it('clamps a position beyond the end to the last track end and flags it', () => {
      expect(absoluteToTrack(book, 5000)).toEqual({ trackIndex: 1, offsetSeconds: 600, clamped: true })
    })
  })

  describe('rounding at track edges', () => {
    const book = [10.5, 20.25] // boundary at 10.5, total 30.75
    it('lands exactly on a fractional boundary at the next track start', () => {
      expect(absoluteToTrack(book, 10.5)).toEqual({ trackIndex: 1, offsetSeconds: 0, clamped: false })
    })
    it('never produces a negative offset just before a boundary', () => {
      const pos = absoluteToTrack(book, 10.4999)
      expect(pos.trackIndex).toBe(0)
      expect(pos.offsetSeconds).toBeGreaterThanOrEqual(0)
      expect(pos.offsetSeconds).toBeCloseTo(10.4999, 6)
    })
    it('handles durations whose cumulative sum drifts in floating point', () => {
      const thirds = [1 / 3, 1 / 3, 1 / 3] // 0.333... each; cumulative sums are inexact
      expect(absoluteToTrack(thirds, 1 / 3).trackIndex).toBe(1)
      const end = absoluteToTrack(thirds, 1)
      expect(end.trackIndex).toBe(2)
      expect(end.clamped).toBe(false)
    })
  })

  it('rejects malformed track durations', () => {
    expect(() => absoluteToTrack([], 0)).toThrow(RangeError)
    expect(() => absoluteToTrack([0], 0)).toThrow(RangeError)
    expect(() => absoluteToTrack([-5], 0)).toThrow(RangeError)
    expect(() => absoluteToTrack([Number.NaN], 0)).toThrow(RangeError)
    expect(() => absoluteToTrack([Number.POSITIVE_INFINITY], 0)).toThrow(RangeError)
  })

  it('rejects a non-finite absolute position', () => {
    expect(() => absoluteToTrack([300], Number.NaN)).toThrow(RangeError)
    expect(() => absoluteToTrack([300], Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('trackToAbsolute', () => {
  const book = [300, 600, 120]

  it('maps track starts and offsets back to absolute positions', () => {
    expect(trackToAbsolute(book, 0, 0)).toBe(0)
    expect(trackToAbsolute(book, 0, 150)).toBe(150)
    expect(trackToAbsolute(book, 1, 0)).toBe(300)
    expect(trackToAbsolute(book, 1, 300)).toBe(600)
    expect(trackToAbsolute(book, 2, 120)).toBe(1020)
  })

  it('clamps an in-track offset into [0, track duration]', () => {
    expect(trackToAbsolute(book, 0, -10)).toBe(0)
    expect(trackToAbsolute(book, 1, 5000)).toBe(300 + 600)
  })

  it('rejects an out-of-range or non-integer track index', () => {
    expect(() => trackToAbsolute(book, -1, 0)).toThrow(RangeError)
    expect(() => trackToAbsolute(book, 3, 0)).toThrow(RangeError)
    expect(() => trackToAbsolute(book, 1.5, 0)).toThrow(RangeError)
  })

  it('rejects a non-finite offset', () => {
    expect(() => trackToAbsolute(book, 0, Number.NaN)).toThrow(RangeError)
  })

  it('rejects malformed track durations', () => {
    expect(() => trackToAbsolute([], 0, 0)).toThrow(RangeError)
  })
})

describe('round trip', () => {
  it('absoluteToTrack then trackToAbsolute recovers in-range positions', () => {
    const book = [300, 600, 120]
    for (const abs of [0, 1, 299.5, 300, 450, 900, 1019.9, 1020]) {
      const pos = absoluteToTrack(book, abs)
      expect(trackToAbsolute(book, pos.trackIndex, pos.offsetSeconds)).toBeCloseTo(abs, 6)
    }
  })
})
