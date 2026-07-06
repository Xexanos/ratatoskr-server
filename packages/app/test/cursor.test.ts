import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, InvalidCursorError } from '../src/abs/cursor.js'

describe('browse cursor', () => {
  it('round-trips a cursor through encode/decode', () => {
    for (const c of [
      { libraryIndex: 0, page: 0 },
      { libraryIndex: 2, page: 5 },
    ]) {
      expect(decodeCursor(encodeCursor(c))).toEqual(c)
    }
  })

  it('treats an absent or empty cursor as the start', () => {
    expect(decodeCursor(undefined)).toEqual({ libraryIndex: 0, page: 0 })
    expect(decodeCursor('')).toEqual({ libraryIndex: 0, page: 0 })
  })

  it('is opaque (not human-readable plain text)', () => {
    expect(encodeCursor({ libraryIndex: 1, page: 2 })).not.toContain('libraryIndex')
  })

  it('rejects a non-base64 / unparseable cursor', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(InvalidCursorError)
    expect(() => decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toThrow(InvalidCursorError)
  })

  it('rejects a structurally invalid cursor (negative or non-integer fields)', () => {
    const bad = Buffer.from(JSON.stringify({ libraryIndex: -1, page: 0 }), 'utf8').toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError)
    const fractional = Buffer.from(JSON.stringify({ libraryIndex: 0, page: 1.5 }), 'utf8').toString('base64url')
    expect(() => decodeCursor(fractional)).toThrow(InvalidCursorError)
  })
})
