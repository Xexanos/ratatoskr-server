import { describe, expect, it } from 'vitest'
import { hmsToSeconds, secondsToHms } from '../src/sonos/time.js'

describe('secondsToHms', () => {
  it('formats seconds as H:MM:SS', () => {
    expect(secondsToHms(0)).toBe('0:00:00')
    expect(secondsToHms(83)).toBe('0:01:23')
    expect(secondsToHms(3661)).toBe('1:01:01')
  })

  it('rounds to whole seconds and floors negatives to zero', () => {
    expect(secondsToHms(1.6)).toBe('0:00:02')
    expect(secondsToHms(-5)).toBe('0:00:00')
    expect(secondsToHms(Number.NaN)).toBe('0:00:00')
  })
})

describe('hmsToSeconds', () => {
  it('parses H:MM:SS into seconds', () => {
    expect(hmsToSeconds('0:01:23')).toBe(83)
    expect(hmsToSeconds('1:01:01')).toBe(3661)
  })

  it('treats non-time values as zero (the safe floor)', () => {
    expect(hmsToSeconds('NOT_IMPLEMENTED')).toBe(0)
    expect(hmsToSeconds('')).toBe(0)
    expect(hmsToSeconds('0:00:00')).toBe(0)
  })

  it('round-trips with secondsToHms', () => {
    expect(hmsToSeconds(secondsToHms(4567))).toBe(4567)
  })
})
