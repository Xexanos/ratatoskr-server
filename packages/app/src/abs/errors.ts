// Errors from the Audiobookshelf upstream. The API layer maps these to contract error
// responses: AbsAuthError -> 401, AbsUpstreamError -> 502.
export class AbsAuthError extends Error {
  constructor(message = 'Audiobookshelf rejected the credentials') {
    super(message)
    this.name = 'AbsAuthError'
  }
}

export class AbsUpstreamError extends Error {
  constructor(message = 'Audiobookshelf request failed') {
    super(message)
    this.name = 'AbsUpstreamError'
  }
}

// The requested resource does not exist upstream (ABS 404). Mapped to 404 NotFound.
export class AbsNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'AbsNotFoundError'
  }
}

// A library item exists but cannot be played: no audio files, or malformed track metadata
// (missing inode/mime, or a non-positive/non-finite duration). The abs/ layer validates ABS
// metadata here so malformed data never reaches the position module (SPEC section 4). Mapped
// to 400 BadRequest by the API layer.
export class ItemNotPlayableError extends Error {
  constructor(itemId: string, reason: string) {
    super(`Item ${itemId} cannot be played: ${reason}`)
    this.name = 'ItemNotPlayableError'
  }
}
