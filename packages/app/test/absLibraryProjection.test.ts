import { describe, expect, it } from 'vitest'
import { toLibraryBook, toLibraryBookDetail, toLibraryBookWithProgress } from '../src/abs/library.js'

// The projections' tolerance for junk from ABS, exercised directly. The behaviour these pin is also
// reached through AbsClient (absLibrary.test.ts) for the ordinary shapes; what only shows up here is
// what happens when an entry is absent or not an object at all — which the list endpoints can hit,
// since a malformed element must not take down a whole page.
describe('ABS -> domain projection edge cases', () => {
  const PROGRESS = { positionSeconds: 5, isFinished: false }

  describe('toLibraryBook', () => {
    it('falls back to a placeholder book for a null or undefined entry', () => {
      for (const raw of [null, undefined]) {
        expect(toLibraryBook(raw)).toEqual({
          id: 'undefined', // ABS gave no id; String(undefined) is what reaches the wire today
          title: '(unknown title)',
          author: undefined,
          durationSeconds: 0,
          hasCover: false,
          progress: undefined,
        })
      }
    })

    // ABS reports a non-numeric or negative duration as 0 rather than passing it on; a wrong-typed
    // title falls back like a missing one.
    it('ignores a non-string title and a negative duration', () => {
      const book = toLibraryBook({ id: 'li_1', media: { duration: -5, metadata: { title: 42 } } })
      expect(book.title).toBe('(unknown title)')
      expect(book.durationSeconds).toBe(0)
    })

    // absLibrary.test.ts covers coverPath null through the client; the empty string is the other
    // falsy shape ABS can produce and must read the same way.
    it('treats an empty coverPath as no cover art', () => {
      expect(toLibraryBook({ id: 'li_1', media: { coverPath: '' } }).hasCover).toBe(false)
    })
  })

  describe('toLibraryBookWithProgress', () => {
    const map = new Map([['li_1', PROGRESS]])

    it('leaves an entry with a non-string or absent id without progress', () => {
      expect(toLibraryBookWithProgress({ id: 7 }, map).progress).toBeUndefined()
      expect(toLibraryBookWithProgress(null, map).progress).toBeUndefined()
    })
  })

  describe('toLibraryBookDetail', () => {
    it('drops a non-string description / narrator but keeps the given progress', () => {
      const detail = toLibraryBookDetail({ id: 'li_1', media: { metadata: { description: 1, narratorName: {} } } }, PROGRESS)
      expect(detail.progress).toEqual(PROGRESS)
      expect(detail.description).toBeUndefined()
      expect(detail.narrator).toBeUndefined()
    })

    it('projects a null entry without throwing', () => {
      expect(toLibraryBookDetail(null, PROGRESS).progress).toEqual(PROGRESS)
    })
  })
})
