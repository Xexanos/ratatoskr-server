import type { components } from '@ratatoskr/contract'
import type { AbsTokenPair } from '../abs/client.js'
import type { LibraryBook, LibraryBookDetail, LibraryBookPage } from '../abs/library.js'
import type { PlaybackSession, RotatedTokenPair } from '../playback/sessionManager.js'
import type { SonosSpeaker } from '../sonos/client.js'

type AuthTokens = components['schemas']['AuthTokens']
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
// The frozen /v1 addition: 1.4.0's Session carries the rotated Audiobookshelf pair when one is
// pending, and 2.0.0 dropped the field, so — like V1AuthTokens — the served surface's shape is
// declared here. Optional, because it appears only while a handover is in flight.
type MappedSession = Session & { item: MappedSummary; rotatedTokens?: RotatedTokenPair | undefined }

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

// ABS's own token pair, which /v1 hands to the client as-is. The shapes coincide today; they are
// mapped rather than passed through because they are not the same thing — the contract's AuthTokens
// is what this major promises, AbsTokenPair is what upstream issued, and a later major replaces the
// former without ABS changing at all.
export function toAuthTokens(pair: AbsTokenPair): AuthTokens {
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    user: { id: pair.user.id, username: pair.user.username },
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
    ...(session.rotatedTokens !== undefined ? { rotatedTokens: session.rotatedTokens } : {}),
  }
}
