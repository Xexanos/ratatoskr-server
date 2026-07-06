// Opaque pagination cursor for /library/items. The contract exposes a single opaque
// `cursor`, but ABS paginates per library, so the cursor encodes which book library we
// are in and which ABS page within it: (libraryIndex, page). Base64url of a tiny JSON
// object — opaque to clients, who only ever echo it back.

export interface BrowseCursor {
  libraryIndex: number
  page: number
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor')
    this.name = 'InvalidCursorError'
  }
}

export function encodeCursor(cursor: BrowseCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

// Decodes a client-supplied cursor. An absent/empty cursor means "start from the
// beginning". A non-empty but unparseable or out-of-range cursor throws
// InvalidCursorError, which the route maps to 400 (the client sent something bad).
export function decodeCursor(raw: string | undefined): BrowseCursor {
  if (raw === undefined || raw === '') return { libraryIndex: 0, page: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError()
  }
  const { libraryIndex, page } = (parsed ?? {}) as Partial<BrowseCursor>
  if (
    !Number.isInteger(libraryIndex) ||
    !Number.isInteger(page) ||
    (libraryIndex as number) < 0 ||
    (page as number) < 0
  ) {
    throw new InvalidCursorError()
  }
  return { libraryIndex: libraryIndex as number, page: page as number }
}
