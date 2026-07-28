// The domain shapes for library data, plus the pure ABS -> domain projections behind them.
// Deliberately free of contract types: what reaches the wire is the edge's business (SPEC section
// 13), and keeping the core ignorant of it is what lets the cover URL — which needs the API's own
// mount prefix — be minted at the edge instead of travelling down into this projection.

// The user's stored listening position for a book. Structurally identical to the contract's
// Progress today; it lives here as its own type so the projection does not have to reach for a
// contract type to express a plain domain fact.
export interface ListeningProgress {
  positionSeconds: number
  isFinished: boolean
}

// A book as the ABS projection sees it.
//
// The optional-looking members are `| undefined` rather than `?:` on purpose: the projection always
// reaches a decision about them, so "not known" is a value it produces, not a property it forgets.
// The contract's own choice to omit the field instead is a wire concern, applied by the mapper. That
// difference is also load-bearing for the compiler — api/contractShapeAssertion.ts explains why, and
// pins it.
export interface LibraryBook {
  id: string
  title: string
  author: string | undefined
  durationSeconds: number
  // Whether ABS holds cover art for this book (from its media.coverPath) — the domain fact behind
  // the contract's coverUrl.
  hasCover: boolean
  progress: ListeningProgress | undefined
}

// A single book with the fields only the detail endpoint fetches. `progress` is narrowed to
// always-present: that endpoint reads it directly rather than joining a per-list map, and a book
// with no listening history reads as a zeroed position rather than nothing.
export interface LibraryBookDetail extends LibraryBook {
  progress: ListeningProgress
  description: string | undefined
  narrator: string | undefined
}

// One page of a browse or search result: the books plus the opaque forward cursor.
export interface LibraryBookPage {
  books: LibraryBook[]
  nextCursor: string | null
}

// The subset of an ABS library-item response the projections read.
interface AbsItem {
  id?: unknown
  media?: {
    duration?: unknown
    coverPath?: unknown
    metadata?: { title?: unknown; authorName?: unknown; narratorName?: unknown; description?: unknown }
  }
}

export function toLibraryBook(raw: unknown, progress?: ListeningProgress): LibraryBook {
  const item = (raw ?? {}) as AbsItem
  const meta = item.media?.metadata ?? {}
  return {
    id: String(item.id),
    title: typeof meta.title === 'string' ? meta.title : '(unknown title)',
    author: typeof meta.authorName === 'string' ? meta.authorName : undefined,
    durationSeconds: typeof item.media?.duration === 'number' && item.media.duration >= 0 ? item.media.duration : 0,
    // ABS signals cover presence via media.coverPath (null when the item has no cover art).
    hasCover: typeof item.media?.coverPath === 'string' && item.media.coverPath !== '',
    progress,
  }
}

// Book projection with the user's progress joined in from the per-list progress map. A book the
// user never listened to carries no progress at all, which the contract renders as an absent field.
export function toLibraryBookWithProgress(raw: unknown, progressByItemId: Map<string, ListeningProgress>): LibraryBook {
  const id = (raw as { id?: unknown } | null | undefined)?.id
  return toLibraryBook(raw, typeof id === 'string' ? progressByItemId.get(id) : undefined)
}

export function toLibraryBookDetail(raw: unknown, progress: ListeningProgress): LibraryBookDetail {
  const meta = ((raw ?? {}) as AbsItem).media?.metadata ?? {}
  return {
    ...toLibraryBook(raw),
    progress,
    description: typeof meta.description === 'string' ? meta.description : undefined,
    narrator: typeof meta.narratorName === 'string' ? meta.narratorName : undefined,
  }
}
