import type { components } from '@ratatoskr/contract'
import { API_PREFIX } from '../apiPrefix.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { AbsAuthError, AbsNotFoundError, AbsUpstreamError, ItemNotPlayableError } from './errors.js'

type AuthTokens = components['schemas']['AuthTokens']
type LibraryItemSummary = components['schemas']['LibraryItemSummary']
type LibraryItem = components['schemas']['LibraryItem']
type LibraryItemList = components['schemas']['LibraryItemList']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type Progress = components['schemas']['Progress']

// Startup-probe timeout (GET /ping). Separate from the per-request timeout: the probe is a one-off
// reachability fingerprint at boot, kept short so a wrong/dead ABS_URL fails startup fast.
const PROBE_TIMEOUT_MS = 2000
// Default per-request timeout when the caller injects none (matches the historical hardcoded value).
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// Buffer size for the in-progress shelf's upstream fetch. ABS applies its `limit` before we filter to
// books, so we over-fetch this many items (well above any realistic simultaneously-in-progress count)
// and then cap at the caller's limit, so interleaved podcasts don't shrink the shelf. See
// listInProgressItems.
const IN_PROGRESS_UPSTREAM_LIMIT = 100

// Outcome of probing ABS_URL: a genuine ABS server, a host that answered but isn't ABS
// (misconfiguration), or no answer at all (down / wrong host / TLS failure).
export type AbsProbeResult = 'ok' | 'not-audiobookshelf' | 'unreachable'

export interface ListItemsQuery {
  searchQuery: string | undefined
  limit: number
  cursor: string | undefined
}

// One playable audio file of a book: the ABS inode used to build the stream URL, its length
// (Sonos's own TrackDuration is unreliable — SPEC section 4), and its mime type for DIDL-Lite.
export interface PlaybackTrack {
  ino: string
  durationSeconds: number
  mimeType: string
}

// The internal (non-contract) projection needed to play a book: the ordered audio files plus
// the total length. Built from ABS `media.audioFiles`; validated so malformed metadata surfaces
// as ItemNotPlayableError rather than reaching the position module.
export interface PlaybackManifest {
  itemId: string
  tracks: PlaybackTrack[]
  totalDurationSeconds: number
  // Display metadata for the DIDL-Lite the speakers show (title/author in the Sonos app). Not used
  // for playback itself; falls back to a placeholder title / empty author when ABS omits them.
  title: string
  author: string
  // The same contract summary the library endpoints project for this book (same title/author/
  // durationSeconds/coverUrl), built from this manifest's own ABS response so the session can echo
  // it on its Session responses without re-fetching. `progress` is deliberately omitted (the session
  // carries the live position separately).
  item: LibraryItemSummary
}

export interface ProgressUpdate {
  currentTimeSeconds: number
  durationSeconds: number
  isFinished: boolean
}

// A cover image proxied from Audiobookshelf: the raw bytes and the upstream content type
// (SPEC: rely on ABS's own resized-cover cache rather than caching in Ratatoskr).
export interface CoverImage {
  contentType: string
  body: Buffer
}

// Client for the Audiobookshelf REST API. Auth (SPEC section 8) proxies login/refresh;
// the library methods produce the thin projection (SPEC section 2) for /library/*. The
// optional dispatcher carries the TLS trust settings for ABS (self-signed pin / insecure);
// undefined means fetch's default (verify against the system CAs).
export class AbsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly dispatcher?: RequestInit['dispatcher'],
    // Per-request timeout for the authenticated library/auth/progress calls. Bounds a hung ABS so
    // it becomes a prompt AbsUpstreamError (-> 502) instead of a stalled request; set it under the
    // client's own read timeout so callers see the mapped 502, not their own timeout.
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  // Only include the dispatcher option when one is configured — with exactOptionalPropertyTypes
  // an explicit `dispatcher: undefined` is a type error, and undefined would mean "use the
  // default" anyway.
  private dispatcherOption(): Pick<RequestInit, 'dispatcher'> | Record<string, never> {
    return this.dispatcher ? { dispatcher: this.dispatcher } : {}
  }

  // Confirms ABS_URL points at a genuine Audiobookshelf server via its unauthenticated
  // `GET /ping` ({ success: true }). Used by the startup check and /health. This is a
  // misconfiguration fingerprint, not authentication — an impostor can fake the response.
  async probe(): Promise<AbsProbeResult> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/ping`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ...this.dispatcherOption(),
      })
    } catch {
      return 'unreachable'
    }
    if (!res.ok) {
      await res.body?.cancel()
      return 'not-audiobookshelf'
    }
    try {
      const data = (await res.json()) as { success?: unknown }
      return data?.success === true ? 'ok' : 'not-audiobookshelf'
    } catch {
      return 'not-audiobookshelf'
    }
  }

  // --- Authentication (proxied; SPEC section 8) ---

  // POST /login with `x-return-tokens: true` so a non-browser client gets the refresh
  // token in the body rather than only as an httpOnly cookie (ABS 2.26+).
  async login(username: string, password: string): Promise<AuthTokens> {
    const data = await this.postJson('/login', { 'x-return-tokens': 'true' }, { username, password })
    return toAuthTokens(data)
  }

  // POST /auth/refresh with the refresh token in the `x-refresh-token` header (ABS 2.26+).
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const data = await this.postJson('/auth/refresh', { 'x-refresh-token': refreshToken }, {})
    return toAuthTokens(data)
  }

  // --- Library projection (SPEC section 2) ---

  // Browse (no query) paginates per book library behind the opaque cursor; search (query
  // set) merges each book library's top matches, capped at `limit`, with no cursor
  // (the ABS search endpoint returns bounded top matches and is not paginated).
  async listItems(token: string, query: ListItemsQuery): Promise<LibraryItemPage> {
    const libraries = await this.listBookLibraries(token)
    if (query.searchQuery !== undefined && query.searchQuery !== '') {
      return this.search(token, libraries, query.searchQuery, query.limit)
    }
    return this.browse(token, libraries, query.limit, query.cursor)
  }

  async getItem(token: string, itemId: string): Promise<LibraryItem> {
    const [item, progress] = await Promise.all([
      this.getJson(`/api/items/${encodeURIComponent(itemId)}`, token),
      this.getProgress(token, itemId),
    ])
    return toLibraryItem(item, progress)
  }

  // Proxy the item's cover image from ABS (GET /api/items/{id}/cover). Forwarding the caller's token
  // both fetches the image and proves the token is valid (SPEC section 8: validity is proven by the
  // upstream ABS call), which is why this route can declare 401/404 like the other library calls.
  // `height` maps to ABS's own `height` cover-resize param, so scaling and the resized-variant cache
  // both live upstream. Unlike getJson/handle the body is binary, so this parses no JSON: it returns
  // the raw bytes and the upstream content type. Deliberately no cache-header forwarding (issue
  // #100): ABS sends none on this path (its CacheManager sets only Content-Type unless the request
  // carries the ABS web client's `?ts=` cache buster, which this proxy never sends), and the only
  // client caches independently of HTTP headers — do not "fix" the forwarding back in.
  async getItemCover(token: string, itemId: string, height: number | undefined): Promise<CoverImage> {
    const query = height !== undefined ? `?height=${encodeURIComponent(String(height))}` : ''
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/items/${encodeURIComponent(itemId)}/cover${query}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...this.dispatcherOption(),
      })
    } catch {
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }
    if (res.status === 401) {
      await res.body?.cancel()
      throw new AbsAuthError()
    }
    if (res.status === 404) {
      await res.body?.cancel()
      throw new AbsNotFoundError()
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new AbsUpstreamError(`Audiobookshelf returned status ${res.status}`)
    }
    const body = Buffer.from(await res.arrayBuffer())
    // ABS always sets a concrete image content type; fall back to a sensible image default just in case.
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    return { contentType, body }
  }

  // The continue-listening shelf (SPEC section 2): books the user has started but not finished,
  // most-recently-listened first. ABS's GET /api/me/items-in-progress already returns exactly that,
  // recency-ordered and excluding finished books, so no client-side sorting is needed. Bounded by
  // `limit` and not paginated (the shelf is a complete, capped set). Filtered to books to match the
  // browse list's book-only scope; podcasts are out of scope for v1. Per-item progress is omitted,
  // consistent with the browse projection (the field is optional; the app derives the marker itself).
  //
  // ABS applies its own `limit` to the mixed-media in-progress list *before* we filter to books, so
  // asking upstream for exactly `limit` could return fewer than `limit` books when podcasts are
  // interleaved. The endpoint is not paginated and has no media-type filter, so over-fetch a generous
  // buffer (the in-progress list is per-user and inherently small) and then cap at `limit`.
  async listInProgressItems(token: string, limit: number): Promise<LibraryItemList> {
    const upstreamLimit = Math.max(limit, IN_PROGRESS_UPSTREAM_LIMIT)
    const data = (await this.getJson(`/api/me/items-in-progress?limit=${upstreamLimit}`, token)) as {
      libraryItems?: unknown[]
    }
    const rawItems = Array.isArray(data.libraryItems) ? data.libraryItems : []
    const items = rawItems
      .filter((raw) => (raw as { mediaType?: unknown })?.mediaType === 'book')
      .slice(0, limit)
      .map(toSummary)
    return { items }
  }

  async getProgress(token: string, itemId: string): Promise<Progress> {
    const data = await this.getJson(`/api/me/progress/${encodeURIComponent(itemId)}`, token, true)
    if (data === null) return { positionSeconds: 0, isFinished: false } // 404: nothing listened yet
    const progressData = data as { currentTime?: unknown; isFinished?: unknown }
    return {
      positionSeconds:
        typeof progressData.currentTime === 'number' && progressData.currentTime > 0 ? progressData.currentTime : 0,
      isFinished: progressData.isFinished === true,
    }
  }

  // Prove a caller's bearer token is a genuine, current ABS token via a cheap authenticated call
  // (GET /api/me). Session endpoints that otherwise never reach ABS (getCurrentSession, stopSession)
  // use this so the presence-only bearer check can't let an unauthenticated LAN caller read or stop
  // the session (the contract declares 401 for an invalid token, not just a missing one).
  async validateToken(token: string): Promise<void> {
    await this.getJson('/api/me', token)
  }

  // --- Playback (SPEC sections 4 and 5) ---

  // Project ABS `media.audioFiles` into the ordered, validated track list needed to play a book.
  // Fails fast with ItemNotPlayableError on no audio files or malformed metadata (missing inode /
  // mime, or a non-positive/non-finite duration) so the position module never sees bad data.
  async getPlaybackManifest(token: string, itemId: string): Promise<PlaybackManifest> {
    const data = await this.getJson(`/api/items/${encodeURIComponent(itemId)}`, token)
    const media = (data as { media?: { audioFiles?: unknown; metadata?: { title?: unknown; authorName?: unknown } } }).media
    const rawFiles = Array.isArray(media?.audioFiles) ? media.audioFiles : []
    if (rawFiles.length === 0) {
      throw new ItemNotPlayableError(itemId, 'no audio files')
    }

    const files = rawFiles.map((raw) => raw as { ino?: unknown; index?: unknown; duration?: unknown; mimeType?: unknown })
    // ABS numbers audio files by `index` (1-based); sort so the queue order is deterministic.
    files.sort((a, b) => (typeof a.index === 'number' ? a.index : 0) - (typeof b.index === 'number' ? b.index : 0))

    const tracks: PlaybackTrack[] = files.map((file) => {
      if (typeof file.ino !== 'string' || file.ino === '') {
        throw new ItemNotPlayableError(itemId, 'an audio file has no inode')
      }
      if (typeof file.duration !== 'number' || !Number.isFinite(file.duration) || file.duration <= 0) {
        throw new ItemNotPlayableError(itemId, `audio file ${file.ino} has an invalid duration`)
      }
      if (typeof file.mimeType !== 'string' || file.mimeType === '') {
        throw new ItemNotPlayableError(itemId, `audio file ${file.ino} has no mime type`)
      }
      return { ino: file.ino, durationSeconds: file.duration, mimeType: file.mimeType }
    })

    const totalDurationSeconds = tracks.reduce((sum, track) => sum + track.durationSeconds, 0)
    const meta = media?.metadata ?? {}
    const title = typeof meta.title === 'string' && meta.title !== '' ? meta.title : '(unknown title)'
    const author = typeof meta.authorName === 'string' ? meta.authorName : ''
    return { itemId, tracks, totalDurationSeconds, title, author, item: toSummary(data) }
  }

  // Write listening progress back to ABS (SPEC section 5). PATCH /api/me/progress/{id} upserts.
  // All four fields are sent deliberately: verified against a live ABS 2.35.1, the endpoint stores
  // only what it is given — it does NOT look up the item's duration or derive `progress`/`isFinished`
  // from `currentTime`. Omitting `duration`/`progress` yields a stored `progress: 0`, and omitting
  // fields makes `isFinished` merge inconsistently. So we compute and send the full set.
  async writeProgress(token: string, itemId: string, update: ProgressUpdate): Promise<void> {
    const fraction = update.isFinished
      ? 1
      : update.durationSeconds > 0
        ? Math.min(1, Math.max(0, update.currentTimeSeconds / update.durationSeconds))
        : 0
    await this.patchJson(`/api/me/progress/${encodeURIComponent(itemId)}`, token, {
      currentTime: update.currentTimeSeconds,
      duration: update.durationSeconds,
      progress: fraction,
      isFinished: update.isFinished,
    })
  }

  private async listBookLibraries(token: string): Promise<{ id: string }[]> {
    const data = await this.getJson('/api/libraries', token)
    const libraries = (data as { libraries?: { id?: unknown; mediaType?: unknown }[] })?.libraries ?? []
    return libraries
      .filter((library) => library.mediaType === 'book' && typeof library.id === 'string')
      .map((library) => ({ id: library.id as string }))
  }

  private async browse(
    token: string,
    libraries: { id: string }[],
    limit: number,
    cursor: string | undefined,
  ): Promise<LibraryItemPage> {
    const { libraryIndex, page } = decodeCursor(cursor)
    const library = libraries[libraryIndex]
    if (library === undefined) return { items: [], nextCursor: null } // cursor past the last library

    const query = `limit=${limit}&page=${page}&sort=media.metadata.title`
    const data = (await this.getJson(`/api/libraries/${encodeURIComponent(library.id)}/items?${query}`, token)) as {
      results?: unknown[]
      total?: number
    }
    const results = Array.isArray(data.results) ? data.results : []
    // ABS returns `total` (all items in the library); page within it while items remain.
    // If `total` is ever missing, fall back to "a full page means there may be more" so a
    // library is never truncated to its first page.
    const moreInThisLibrary =
      typeof data.total === 'number' ? (page + 1) * limit < data.total : results.length === limit

    let nextCursor: string | null = null
    if (moreInThisLibrary) {
      nextCursor = encodeCursor({ libraryIndex, page: page + 1 })
    } else if (libraryIndex + 1 < libraries.length) {
      nextCursor = encodeCursor({ libraryIndex: libraryIndex + 1, page: 0 })
    }
    return { items: results.map(toSummary), nextCursor }
  }

  private async search(
    token: string,
    libraries: { id: string }[],
    searchQuery: string,
    limit: number,
  ): Promise<LibraryItemPage> {
    const perLibrary = await Promise.all(
      libraries.map(async (library) => {
        const data = (await this.getJson(
          `/api/libraries/${encodeURIComponent(library.id)}/search?q=${encodeURIComponent(searchQuery)}&limit=${limit}`,
          token,
        )) as { book?: { libraryItem?: unknown }[] }
        return Array.isArray(data.book) ? data.book : []
      }),
    )
    const items = perLibrary
      .flat()
      .map((match) => toSummary(match.libraryItem))
      .slice(0, limit)
    return { items, nextCursor: null }
  }

  private async postJson(
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...this.dispatcherOption(),
      })
    } catch {
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }
    return this.handle(res, false)
  }

  private async getJson(path: string, token: string, allowNotFound = false): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...this.dispatcherOption(),
      })
    } catch {
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }
    return this.handle(res, allowNotFound)
  }

  // PATCH that only checks the status; the success body is ignored (ABS returns the updated
  // progress, which the caller does not need), so — unlike getJson/handle — it is not parsed.
  private async patchJson(path: string, token: string, body: unknown): Promise<void> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...this.dispatcherOption(),
      })
    } catch {
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }
    await res.body?.cancel()
    if (res.status === 401) throw new AbsAuthError()
    if (res.status === 404) throw new AbsNotFoundError()
    if (!res.ok) throw new AbsUpstreamError(`Audiobookshelf returned status ${res.status}`)
  }

  private async handle(res: Response, allowNotFound: boolean): Promise<unknown> {
    if (res.status === 401) {
      await res.body?.cancel()
      throw new AbsAuthError()
    }
    if (res.status === 404) {
      await res.body?.cancel()
      if (allowNotFound) return null
      throw new AbsNotFoundError()
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new AbsUpstreamError(`Audiobookshelf returned status ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new AbsUpstreamError('Audiobookshelf returned an unparseable response')
    }
  }
}

// --- Pure projections: ABS item -> contract shapes ---

interface AbsItem {
  id?: unknown
  media?: {
    duration?: unknown
    coverPath?: unknown
    metadata?: { title?: unknown; authorName?: unknown; narratorName?: unknown; description?: unknown }
  }
}

// The cover image is served by Ratatoskr's own cover-proxy route (getItemCover), so coverUrl points
// there rather than at ABS. A path relative to the server origin (it includes the same version mount
// prefix as the routes, from the shared API_PREFIX constant): the client resolves it against the
// base it is already talking to, and it needs no request context, so it can be built here in the
// pure projection.
function coverPathFor(id: string): string {
  return `${API_PREFIX}/library/items/${encodeURIComponent(id)}/cover`
}

function toSummary(raw: unknown): LibraryItemSummary {
  const item = (raw ?? {}) as AbsItem
  const meta = item.media?.metadata ?? {}
  const id = String(item.id)
  // ABS signals cover presence via media.coverPath (null when the item has no cover art). The
  // contract promises coverUrl null in that case — pointing at the proxy route anyway would hand
  // clients a guaranteed 404 they re-fetch on every scroll.
  const hasCover = typeof item.media?.coverPath === 'string' && item.media.coverPath !== ''
  return {
    id,
    title: typeof meta.title === 'string' ? meta.title : '(unknown title)',
    durationSeconds: typeof item.media?.duration === 'number' && item.media.duration >= 0 ? item.media.duration : 0,
    coverUrl: hasCover ? coverPathFor(id) : null,
    ...(typeof meta.authorName === 'string' ? { author: meta.authorName } : {}),
  }
}

function toLibraryItem(raw: unknown, progress: Progress): LibraryItem {
  const meta = ((raw ?? {}) as AbsItem).media?.metadata ?? {}
  return {
    ...toSummary(raw),
    progress,
    ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    ...(typeof meta.narratorName === 'string' ? { narrator: meta.narratorName } : {}),
  }
}

function toAuthTokens(data: unknown): AuthTokens {
  const user = (data as { user?: { id?: unknown; username?: unknown; accessToken?: unknown; refreshToken?: unknown } })?.user
  const accessToken = user?.accessToken
  const refreshToken = user?.refreshToken
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !user) {
    throw new AbsUpstreamError('Audiobookshelf did not return the expected tokens')
  }
  return {
    accessToken,
    refreshToken,
    user: { id: String(user.id), username: String(user.username) },
  }
}
