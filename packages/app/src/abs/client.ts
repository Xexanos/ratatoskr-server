import type { components } from '@ratatoskr/contract'
import { decodeCursor, encodeCursor } from './cursor.js'
import { AbsAuthError, AbsNotFoundError, AbsUpstreamError } from './errors.js'

type AuthTokens = components['schemas']['AuthTokens']
type LibraryItemSummary = components['schemas']['LibraryItemSummary']
type LibraryItem = components['schemas']['LibraryItem']
type LibraryItemPage = components['schemas']['LibraryItemPage']
type Progress = components['schemas']['Progress']

const REQUEST_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 2000

// Outcome of probing ABS_URL: a genuine ABS server, a host that answered but isn't ABS
// (misconfiguration), or no answer at all (down / wrong host / TLS failure).
export type AbsProbeResult = 'ok' | 'not-audiobookshelf' | 'unreachable'

export interface ListItemsQuery {
  searchQuery: string | undefined
  limit: number
  cursor: string | undefined
}

// Client for the Audiobookshelf REST API. Auth (SPEC section 8) proxies login/refresh;
// the library methods produce the thin projection (SPEC section 2) for /library/*. The
// optional dispatcher carries the TLS trust settings for ABS (self-signed pin / insecure);
// undefined means fetch's default (verify against the system CAs).
export class AbsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly dispatcher?: RequestInit['dispatcher'],
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...this.dispatcherOption(),
      })
    } catch {
      throw new AbsUpstreamError('Audiobookshelf did not respond')
    }
    return this.handle(res, allowNotFound)
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
  media?: { duration?: unknown; metadata?: { title?: unknown; authorName?: unknown; narratorName?: unknown; description?: unknown } }
}

function toSummary(raw: unknown): LibraryItemSummary {
  const item = (raw ?? {}) as AbsItem
  const meta = item.media?.metadata ?? {}
  return {
    id: String(item.id),
    title: typeof meta.title === 'string' ? meta.title : '(unknown title)',
    durationSeconds: typeof item.media?.duration === 'number' && item.media.duration >= 0 ? item.media.duration : 0,
    coverUrl: null, // v1: no cover route in the contract yet (SPEC section 14 open point)
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
  const tokenData = data as { accessToken?: unknown; refreshToken?: unknown; user?: { id?: unknown; username?: unknown } }
  const accessToken = tokenData?.accessToken
  const refreshToken = tokenData?.refreshToken
  const user = tokenData?.user
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !user) {
    throw new AbsUpstreamError('Audiobookshelf did not return the expected tokens')
  }
  return {
    accessToken,
    refreshToken,
    user: { id: String(user.id), username: String(user.username) },
  }
}
