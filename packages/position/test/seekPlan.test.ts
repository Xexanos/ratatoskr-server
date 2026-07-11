import { describe, expect, it } from 'vitest'
import { planSeek, type SeekTuning } from '../src/seekPlan.js'

const TUNING: SeekTuning = { settleMs: 1000, toleranceSeconds: 3, retries: 2 }

describe('planSeek', () => {
  it('resolves the target track and in-track offset for a mid-book position', () => {
    // durations [100, 200, 300]; 250s is 150s into track 2 (index 1).
    const plan = planSeek([100, 200, 300], 250, TUNING)
    expect(plan.trackIndex).toBe(1)
    expect(plan.offsetSeconds).toBe(150)
    expect(plan.clamped).toBe(false)
    expect(plan.tuning).toEqual(TUNING)
  })

  it('plans the start of the book', () => {
    const plan = planSeek([100, 200], 0, TUNING)
    expect(plan.trackIndex).toBe(0)
    expect(plan.offsetSeconds).toBe(0)
    expect(plan.clamped).toBe(false)
  })

  it('clamps a target past the end and flags it', () => {
    const plan = planSeek([100, 200], 9999, TUNING)
    expect(plan.trackIndex).toBe(1)
    expect(plan.offsetSeconds).toBe(200)
    expect(plan.clamped).toBe(true)
  })

  it('carries the tuning through untouched', () => {
    const tuning: SeekTuning = { settleMs: 500, toleranceSeconds: 1, retries: 0 }
    expect(planSeek([60], 10, tuning).tuning).toBe(tuning)
  })

  it('rejects invalid tuning', () => {
    expect(() => planSeek([60], 10, { settleMs: -1, toleranceSeconds: 3, retries: 2 })).toThrow(/settleMs/)
    expect(() => planSeek([60], 10, { settleMs: 1000, toleranceSeconds: -1, retries: 2 })).toThrow(/toleranceSeconds/)
    expect(() => planSeek([60], 10, { settleMs: 1000, toleranceSeconds: 3, retries: 1.5 })).toThrow(/retries/)
  })

  it('propagates duration validation from the mapper', () => {
    expect(() => planSeek([], 10, TUNING)).toThrow(RangeError)
    expect(() => planSeek([0, 10], 5, TUNING)).toThrow(RangeError)
  })
})
