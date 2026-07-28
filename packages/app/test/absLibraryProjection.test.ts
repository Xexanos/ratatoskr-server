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

    it('ignores a non-string title, a non-numeric duration and a negative duration', () => {
      const book = toLibraryBook({ id: 'li_1', media: { duration: -5, metadata: { title: 42 } } })
      expect(book.title).toBe('(unknown title)')
      expect(book.durationSeconds).toBe(0)
    })

    it('treats an empty coverPath as no cover art', () => {
      expect(toLibraryBook({ id: 'li_1', media: { coverPath: '' } }).hasCover).toBe(false)
      expect(toLibraryBook({ id: 'li_1', media: { coverPath: '/covers/x.jpg' } }).hasCover).toBe(true)
    })
  })

  describe('toLibraryBookWithProgress', () => {
    const map = new Map([['li_1', PROGRESS]])

    it('joins progress by id and leaves an unknown id without any', () => {
      expect(toLibraryBookWithProgress({ id: 'li_1' }, map).progress).toEqual(PROGRESS)
      expect(toLibraryBookWithProgress({ id: 'li_other' }, map).progress).toBeUndefined()
    })

    it('leaves an entry with a missing or non-string id without progress', () => {
      expect(toLibraryBookWithProgress({ id: 7 }, map).progress).toBeUndefined()
      expect(toLibraryBookWithProgress(null, map).progress).toBeUndefined()
    })
  })

  describe('toLibraryBookDetail', () => {
    it('keeps the given progress and drops non-string description / narrator', () => {
      const detail = toLibraryBookDetail({ id: 'li_1', media: { metadata: { description: 1, narratorName: {} } } }, PROGRESS)
      expect(detail.progress).toEqual(PROGRESS)
      expect(detail.description).toBeUndefined()
      expect(detail.narrator).toBeUndefined()
    })

    it('carries description and narrator when ABS provides them', () => {
      const detail = toLibraryBookDetail({ id: 'li_1', media: { metadata: { description: 'D', narratorName: 'N' } } }, PROGRESS)
      expect(detail).toMatchObject({ description: 'D', narrator: 'N' })
    })

    it('projects a null entry without throwing', () => {
      expect(toLibraryBookDetail(null, PROGRESS).progress).toEqual(PROGRESS)
    })
  })
})
