import { describe, expect, it } from 'vitest'
import { planPlayback } from '../src/playbackPlan.js'

describe('planPlayback', () => {
  it('plans a single-track book', () => {
    const plan = planPlayback([{ url: 'http://abs/file/1?token=t', mimeType: 'audio/mpeg', durationSeconds: 120 }])
    expect(plan.tracks).toEqual([
      { url: 'http://abs/file/1?token=t', mimeType: 'audio/mpeg', durationSeconds: 120, title: 'Track 1', author: '' },
    ])
    expect(plan.trackDurations).toEqual([120])
    expect(plan.totalDurationSeconds).toBe(120)
  })

  it('preserves order and durations for a multi-track book, defaulting titles', () => {
    const plan = planPlayback([
      { url: 'http://abs/file/1?token=t', mimeType: 'audio/mp4', durationSeconds: 100 },
      { url: 'http://abs/file/2?token=t', mimeType: 'audio/mp4', durationSeconds: 200, title: 'Chapter Two' },
    ])
    expect(plan.tracks.map((track) => track.title)).toEqual(['Track 1', 'Chapter Two'])
    expect(plan.tracks.map((track) => track.url)).toEqual(['http://abs/file/1?token=t', 'http://abs/file/2?token=t'])
    expect(plan.trackDurations).toEqual([100, 200])
    expect(plan.totalDurationSeconds).toBe(300)
  })

  it('treats a blank title as absent and falls back to Track N', () => {
    const plan = planPlayback([{ url: 'u', mimeType: 'audio/flac', durationSeconds: 10, title: '   ' }])
    expect(plan.tracks[0]?.title).toBe('Track 1')
  })

  it('carries an explicit author through, defaulting to empty', () => {
    const plan = planPlayback([
      { url: 'u1', mimeType: 'audio/mpeg', durationSeconds: 10, title: 'T', author: 'Jane Doe' },
      { url: 'u2', mimeType: 'audio/mpeg', durationSeconds: 10 },
    ])
    expect(plan.tracks.map((track) => track.author)).toEqual(['Jane Doe', ''])
  })

  it('throws on an empty track list', () => {
    expect(() => planPlayback([])).toThrow(RangeError)
  })

  it('throws when a track is missing its url or mime type', () => {
    expect(() => planPlayback([{ url: '', mimeType: 'audio/mpeg', durationSeconds: 10 }])).toThrow(/url/)
    expect(() => planPlayback([{ url: 'u', mimeType: '', durationSeconds: 10 }])).toThrow(/mimeType/)
  })

  it('throws on a non-positive or non-finite duration (bad ABS metadata)', () => {
    expect(() => planPlayback([{ url: 'u', mimeType: 'audio/mpeg', durationSeconds: 0 }])).toThrow(RangeError)
    expect(() => planPlayback([{ url: 'u', mimeType: 'audio/mpeg', durationSeconds: Number.NaN }])).toThrow(RangeError)
  })
})
