import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbsClient } from '../src/abs/client.js'
import { AbsNotFoundError } from '../src/abs/errors.js'
import { decodeCursor } from '../src/abs/cursor.js'

const BASE = 'http://abs.invalid'

// Route a stubbed fetch by URL substring. Each matcher returns the JSON body (status 200)
// or a bare status.
function stubRoutes(routes: { match: string; body?: unknown; status?: number }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      // Longest matching path wins, so '/api/libraries/lib1/items' beats '/api/libraries'.
      const route = routes
        .filter((candidate) => url.includes(candidate.match))
        .sort((left, right) => right.match.length - left.match.length)[0]
      if (!route) return Promise.resolve(new Response(null, { status: 404 }))
      if (route.status && route.status !== 200) return Promise.resolve(new Response(null, { status: route.status }))
      return Promise.resolve(
        new Response(JSON.stringify(route.body), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }),
  )
}

const absBook = (id: string, title: string, author: string, duration: number) => ({
  id,
  mediaType: 'book',
  media: { duration, metadata: { title, authorName: author, narratorName: 'Nar', description: 'Desc' } },
})

const TWO_BOOK_LIBS = {
  match: '/api/libraries',
  body: {
    libraries: [
      { id: 'lib1', mediaType: 'book' },
      { id: 'podcasts', mediaType: 'podcast' }, // filtered out
      { id: 'lib3', mediaType: 'book' },
    ],
  },
}

describe('AbsClient library projection', () => {
  afterEach(() => vi.unstubAllGlobals())

  describe('browse (no query)', () => {
    it('projects items and pages within a library via the cursor', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        {
          match: '/api/libraries/lib1/items',
          body: { results: [absBook('li_1', 'Alpha', 'Author A', 3600), absBook('li_2', 'Beta', 'Author B', 60)], total: 5 },
        },
      ])
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor: undefined })

      expect(page.items).toEqual([
        { id: 'li_1', title: 'Alpha', author: 'Author A', durationSeconds: 3600, coverUrl: null },
        { id: 'li_2', title: 'Beta', author: 'Author B', durationSeconds: 60, coverUrl: null },
      ])
      // 2 of 5 shown → more in this library.
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ libraryIndex: 0, page: 1 })
    })

    it('advances to the next book library at the end of the current one', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        { match: '/api/libraries/lib1/items', body: { results: [absBook('li_9', 'Zeta', 'Z', 10)], total: 3 } },
      ])
      // cursor at lib1 page 1, limit 2 -> (1+1)*2=4 >= total 3 -> last page -> advance to lib3.
      const cursor = Buffer.from(JSON.stringify({ libraryIndex: 0, page: 1 }), 'utf8').toString('base64url')
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor })
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ libraryIndex: 1, page: 0 })
    })

    it('has no nextCursor at the end of the last library', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        { match: '/api/libraries/lib3/items', body: { results: [absBook('li_x', 'End', 'E', 5)], total: 1 } },
      ])
      const cursor = Buffer.from(JSON.stringify({ libraryIndex: 1, page: 0 }), 'utf8').toString('base64url')
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor })
      expect(page.nextCursor).toBeNull()
    })

    it('keeps paging within a library when ABS omits total and the page is full', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        // No `total` field: a full page (== limit) must still yield a next cursor rather
        // than truncating the library to its first page.
        { match: '/api/libraries/lib1/items', body: { results: [absBook('li_1', 'Alpha', 'A', 1), absBook('li_2', 'Beta', 'B', 2)] } },
      ])
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor: undefined })
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ libraryIndex: 0, page: 1 })
    })

    it('advances past a library when ABS omits total and the page is not full', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        { match: '/api/libraries/lib1/items', body: { results: [absBook('li_1', 'Alpha', 'A', 1)] } },
      ])
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor: undefined })
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ libraryIndex: 1, page: 0 })
    })

    it('returns an empty page when the cursor points past the last library', async () => {
      stubRoutes([TWO_BOOK_LIBS])
      const cursor = Buffer.from(JSON.stringify({ libraryIndex: 5, page: 0 }), 'utf8').toString('base64url')
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: undefined, limit: 2, cursor })
      expect(page).toEqual({ items: [], nextCursor: null })
    })
  })

  describe('search (query set)', () => {
    it('merges book matches across libraries, capped at limit, with no cursor', async () => {
      stubRoutes([
        TWO_BOOK_LIBS,
        { match: '/api/libraries/lib1/search', body: { book: [{ libraryItem: absBook('li_1', 'Match One', 'A', 10) }] } },
        { match: '/api/libraries/lib3/search', body: { book: [{ libraryItem: absBook('li_2', 'Match Two', 'B', 20) }] } },
      ])
      const page = await new AbsClient(BASE).listItems('tok', { searchQuery: 'match', limit: 50, cursor: undefined })
      expect(page.items.map((item) => item.id)).toEqual(['li_1', 'li_2'])
      expect(page.nextCursor).toBeNull()
    })
  })

  describe('getItem', () => {
    it('combines item metadata with progress', async () => {
      stubRoutes([
        { match: '/api/items/li_1', body: absBook('li_1', 'Alpha', 'Author A', 3600) },
        { match: '/api/me/progress/li_1', body: { currentTime: 123.5, isFinished: false } },
      ])
      const item = await new AbsClient(BASE).getItem('tok', 'li_1')
      expect(item).toEqual({
        id: 'li_1',
        title: 'Alpha',
        author: 'Author A',
        durationSeconds: 3600,
        coverUrl: null,
        description: 'Desc',
        narrator: 'Nar',
        progress: { positionSeconds: 123.5, isFinished: false },
      })
    })

    it('falls back gracefully when ABS metadata fields are missing', async () => {
      stubRoutes([
        { match: '/api/items/li_min', body: { id: 'li_min' } }, // no media/metadata at all
        { match: '/api/me/progress/li_min', status: 404 },
      ])
      const item = await new AbsClient(BASE).getItem('tok', 'li_min')
      expect(item).toEqual({
        id: 'li_min',
        title: '(unknown title)',
        durationSeconds: 0,
        coverUrl: null,
        progress: { positionSeconds: 0, isFinished: false },
      })
      expect(item).not.toHaveProperty('author')
      expect(item).not.toHaveProperty('description')
      expect(item).not.toHaveProperty('narrator')
    })

    it('maps a missing item to AbsNotFoundError', async () => {
      stubRoutes([
        { match: '/api/items/ghost', status: 404 },
        { match: '/api/me/progress/ghost', status: 404 },
      ])
      await expect(new AbsClient(BASE).getItem('tok', 'ghost')).rejects.toBeInstanceOf(AbsNotFoundError)
    })
  })

  describe('getProgress', () => {
    it('defaults to zero / not finished when ABS has no progress (404)', async () => {
      stubRoutes([{ match: '/api/me/progress/li_new', status: 404 }])
      expect(await new AbsClient(BASE).getProgress('tok', 'li_new')).toEqual({ positionSeconds: 0, isFinished: false })
    })
  })
})
