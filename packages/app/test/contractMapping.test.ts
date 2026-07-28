import { describe, expect, it } from 'vitest'
import type { LibraryBook, LibraryBookDetail } from '../src/abs/library.js'
import {
  toAuthTokens,
  toLibraryItem,
  toLibraryItemList,
  toLibraryItemPage,
  toLibraryItemSummary,
  toSessionResponse,
  toSpeaker,
} from '../src/api/contractMapping.js'
import type { PlaybackSession } from '../src/playback/sessionManager.js'

const PREFIX = '/v1'

const book = (overrides: Partial<LibraryBook> = {}): LibraryBook => ({
  id: 'li_1',
  title: 'Alpha',
  author: 'Author A',
  durationSeconds: 3600,
  hasCover: true,
  progress: undefined,
  ...overrides,
})

describe('domain -> contract mapping', () => {
  describe('coverUrl', () => {
    it('mints the cover-proxy path under the given mount prefix when the book has cover art', () => {
      expect(toLibraryItemSummary(book(), PREFIX).coverUrl).toBe('/v1/library/items/li_1/cover')
    })

    // The point of minting at the edge: a request served under a different major must be handed
    // that major's own cover path, not the one baked in when the projection ran.
    it('carries the requesting major prefix rather than a fixed one', () => {
      expect(toLibraryItemSummary(book(), '/v2').coverUrl).toBe('/v2/library/items/li_1/cover')
    })

    it('is null when Audiobookshelf holds no cover art', () => {
      expect(toLibraryItemSummary(book({ hasCover: false }), PREFIX).coverUrl).toBeNull()
    })

    it('percent-encodes the item id', () => {
      expect(toLibraryItemSummary(book({ id: 'li/1 x' }), PREFIX).coverUrl).toBe('/v1/library/items/li%2F1%20x/cover')
    })
  })

  describe('summary', () => {
    it('maps the full shape', () => {
      const progress = { positionSeconds: 123.5, isFinished: false }
      expect(toLibraryItemSummary(book({ progress }), PREFIX)).toEqual({
        id: 'li_1',
        title: 'Alpha',
        author: 'Author A',
        durationSeconds: 3600,
        coverUrl: '/v1/library/items/li_1/cover',
        progress,
      })
    })

    // The domain says "unknown" with an explicit undefined; the contract says it by omitting the
    // field. Emitting `author: undefined` instead would put a null on the wire.
    it('omits author and progress rather than emitting undefined when the domain has none', () => {
      const summary = toLibraryItemSummary(book({ author: undefined, progress: undefined }), PREFIX)
      expect(summary).not.toHaveProperty('author')
      expect(summary).not.toHaveProperty('progress')
    })
  })

  describe('page and list', () => {
    it('maps books to items and keeps the cursor', () => {
      const page = { books: [book(), book({ id: 'li_2', hasCover: false })], nextCursor: 'abc' }
      expect(toLibraryItemPage(page, PREFIX)).toEqual({
        items: [
          { id: 'li_1', title: 'Alpha', author: 'Author A', durationSeconds: 3600, coverUrl: '/v1/library/items/li_1/cover' },
          { id: 'li_2', title: 'Alpha', author: 'Author A', durationSeconds: 3600, coverUrl: null },
        ],
        nextCursor: 'abc',
      })
    })

    it('keeps a null cursor null', () => {
      expect(toLibraryItemPage({ books: [], nextCursor: null }, PREFIX)).toEqual({ items: [], nextCursor: null })
    })

    it('wraps a bare book array as a list', () => {
      expect(toLibraryItemList([book()], PREFIX)).toEqual({
        items: [
          { id: 'li_1', title: 'Alpha', author: 'Author A', durationSeconds: 3600, coverUrl: '/v1/library/items/li_1/cover' },
        ],
      })
    })
  })

  describe('item detail', () => {
    const detail = (overrides: Partial<LibraryBookDetail> = {}): LibraryBookDetail => ({
      ...book(),
      progress: { positionSeconds: 0, isFinished: false },
      description: 'Desc',
      narrator: 'Nar',
      ...overrides,
    })

    it('maps the detail fields on top of the summary', () => {
      expect(toLibraryItem(detail(), PREFIX)).toEqual({
        id: 'li_1',
        title: 'Alpha',
        author: 'Author A',
        durationSeconds: 3600,
        coverUrl: '/v1/library/items/li_1/cover',
        progress: { positionSeconds: 0, isFinished: false },
        description: 'Desc',
        narrator: 'Nar',
      })
    })

    it('omits description and narrator when the domain has none', () => {
      const item = toLibraryItem(detail({ description: undefined, narrator: undefined }), PREFIX)
      expect(item).not.toHaveProperty('description')
      expect(item).not.toHaveProperty('narrator')
    })
  })

  describe('speaker', () => {
    it('carries a group with its member room names', () => {
      const zone = { id: 'rincon_1', name: 'Living Room', isGroup: true, members: ['Kitchen', 'Living Room'] }
      expect(toSpeaker(zone)).toEqual(zone)
    })

    it('drops members entirely for a lone speaker rather than sending undefined or an empty list', () => {
      const speaker = toSpeaker({ id: 'rincon_2', name: 'Office', isGroup: false, members: undefined })
      expect(speaker).toEqual({ id: 'rincon_2', name: 'Office', isGroup: false })
      expect(speaker).not.toHaveProperty('members')
    })
  })

  describe('auth tokens', () => {
    it('maps the ABS pair and its user onto the contract shape', () => {
      const pair = {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        user: { id: 'usr_1', username: 'lars' },
      }
      expect(toAuthTokens(pair)).toEqual(pair)
    })

    // A fresh object, not the upstream one passed through: the two types coincide today but are not
    // the same thing, and a later major replaces the contract side without ABS changing.
    it('does not hand back the upstream object itself', () => {
      const pair = { accessToken: 'a', refreshToken: 'r', user: { id: 'u', username: 'n' } }
      const mapped = toAuthTokens(pair)
      expect(mapped).not.toBe(pair)
      expect(mapped.user).not.toBe(pair.user)
    })
  })

  describe('session', () => {
    const session = (overrides: Partial<PlaybackSession> = {}): PlaybackSession => ({
      itemId: 'li_1',
      item: book(),
      speakerId: 'sp_1',
      state: 'playing',
      positionSeconds: 12,
      durationSeconds: 3600,
      updatedAt: '2026-07-28T00:00:00.000Z',
      rotatedTokens: undefined,
      ...overrides,
    })

    // Session.item is the fifth place library data leaves the core: the manager holds the domain
    // book for the whole session and the URL is minted per response, so it can never go stale
    // against the major that asked for it.
    it('maps the echoed item through the same summary mapping', () => {
      expect(toSessionResponse(session(), PREFIX).item).toEqual({
        id: 'li_1',
        title: 'Alpha',
        author: 'Author A',
        durationSeconds: 3600,
        coverUrl: '/v1/library/items/li_1/cover',
      })
      expect(toSessionResponse(session(), '/v2').item.coverUrl).toBe('/v2/library/items/li_1/cover')
    })

    it('carries the session fields through unchanged', () => {
      expect(toSessionResponse(session(), PREFIX)).toMatchObject({
        itemId: 'li_1',
        speakerId: 'sp_1',
        state: 'playing',
        positionSeconds: 12,
        durationSeconds: 3600,
        updatedAt: '2026-07-28T00:00:00.000Z',
      })
    })

    it('passes a pending rotated pair through and omits it when there is none', () => {
      const rotatedTokens = { accessToken: 'new-access', refreshToken: 'new-refresh' }
      expect(toSessionResponse(session({ rotatedTokens }), PREFIX).rotatedTokens).toEqual(rotatedTokens)
      expect(toSessionResponse(session(), PREFIX)).not.toHaveProperty('rotatedTokens')
    })
  })
})
