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
