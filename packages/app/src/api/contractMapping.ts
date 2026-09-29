import type { components } from '@ratatoskr/contract'
import type { LibraryBook, LibraryBookDetail, LibraryBookPage } from '../abs/library.js'
import type { DeviceSession, DeviceSessionSummary } from '../auth/authService.js'
import type { PlaybackSession } from '../playback/sessionManager.js'
import type { SonosSpeaker } from '../sonos/client.js'

type AuthSession = components['schemas']['AuthSession']
type DeviceSessionList = components['schemas']['DeviceSessionList']
type LibraryItemSummary = components['schemas']['LibraryItemSummary']
type LibraryItem = components['schemas']['LibraryItem']
type LibraryItemList = components['schemas']['LibraryItemList']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type Progress = components['schemas']['Progress']
type Session = components['schemas']['Session']
type Speaker = components['schemas']['Speaker']

// The mappers' return types, not the bare contract types. The contract does not mark coverUrl,
// progress or Session.item as required, so a mapper that simply forgot one of them would still
// typecheck and put a subtly wrong body on the wire — the exact failure this module exists to make
// impossible. Requiring them here is what turns "forgot to map" into a compile error; every field
// named below is one the server has always populated, so this pins current behavior rather than
// promising anything new.
type MappedSummary = LibraryItemSummary & { coverUrl: string | null }
type MappedItem = LibraryItem & { coverUrl: string | null; progress: Progress }
// A session as the surface puts it on the wire. Note what is *not* here: any Audiobookshelf token.
// The domain session carries none, so "no upstream credential on the wire" (SPEC section 8) does not
// rest on the serializer dropping a field absent from the response schema.
export type MappedSession = Session & { item: MappedSummary }

// The cover image is served by Ratatoskr's own cover-proxy route, so coverUrl points there rather
// than at ABS. A path relative to the server origin, carrying the mount prefix of the major that
// is being served: the client resolves it against the base it is already talking to, and a client
// on one major is never handed a path into another one's surface. Minted here, at the edge, because
// this is the only layer that knows which mount the response is leaving through.
function coverPathFor(apiPrefix: string, id: string): string {
  return `${apiPrefix}/library/items/${encodeURIComponent(id)}/cover`
}

// The domain's explicit `undefined` means "not known"; the contract says the same thing by leaving
// the field out, and under exactOptionalPropertyTypes an explicit undefined is not even assignable
// to the optional property. Hence the spread-or-nothing idiom throughout.
export function toLibraryItemSummary(book: LibraryBook, apiPrefix: string): MappedSummary {
  return {
    id: book.id,
    title: book.title,
    durationSeconds: book.durationSeconds,
    coverUrl: book.hasCover ? coverPathFor(apiPrefix, book.id) : null,
    ...(book.author !== undefined ? { author: book.author } : {}),
    ...(book.progress !== undefined ? { progress: book.progress } : {}),
  }
}

export function toLibraryItem(detail: LibraryBookDetail, apiPrefix: string): MappedItem {
  return {
    ...toLibraryItemSummary(detail, apiPrefix),
    progress: detail.progress,
    ...(detail.description !== undefined ? { description: detail.description } : {}),
    ...(detail.narrator !== undefined ? { narrator: detail.narrator } : {}),
  }
}

export function toLibraryItemList(books: LibraryBook[], apiPrefix: string): LibraryItemList {
  return { items: books.map((book) => toLibraryItemSummary(book, apiPrefix)) }
}

export function toLibraryItemPage(page: LibraryBookPage, apiPrefix: string): LibraryItemPage {
  return { items: page.books.map((book) => toLibraryItemSummary(book, apiPrefix)), nextCursor: page.nextCursor }
}

// A Sonos zone group as this major exposes it. `members` is dropped for a lone speaker: the contract
// documents the field as "room names in the group, when isGroup is true", so an empty or absent list
// are not interchangeable to a client rendering it.
export function toSpeaker(speaker: SonosSpeaker): Speaker {
  return {
    id: speaker.id,
    name: speaker.name,
    isGroup: speaker.isGroup,
    ...(speaker.members !== undefined ? { members: speaker.members } : {}),
  }
}

// A signed-in device as its client sees it: the Ratatoskr token and the identity, and no Audiobookshelf
// token at all. Takes the DeviceSession rather than a store entry, so a caller has nothing to hand it
// that carries a chain.
export function toAuthSession(session: DeviceSession): AuthSession {
  return {
    token: session.token,
    user: { id: session.user.id, username: session.user.username },
  }
}

// The caller's device session list. Built field by field from DeviceSessionSummary, which carries no
// credential, so the response cannot pick one up.
export function toDeviceSessionList(sessions: readonly DeviceSessionSummary[]): DeviceSessionList {
  return {
    items: sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      current: session.current,
      ...(session.deviceName !== undefined ? { deviceName: session.deviceName } : {}),
      ...(session.lastUsedAt !== undefined ? { lastUsedAt: session.lastUsedAt } : {}),
    })),
  }
}

export function toSessionResponse(session: PlaybackSession, apiPrefix: string): MappedSession {
  return {
    itemId: session.itemId,
    item: toLibraryItemSummary(session.item, apiPrefix),
    speakerId: session.speakerId,
    state: session.state,
    positionSeconds: session.positionSeconds,
    durationSeconds: session.durationSeconds,
    updatedAt: session.updatedAt,
  }
}
