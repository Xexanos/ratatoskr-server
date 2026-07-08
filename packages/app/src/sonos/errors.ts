// Errors from the Sonos control layer. The API layer maps these to contract error
// responses: SonosUpstreamError -> 502.
export class SonosUpstreamError extends Error {
  constructor(message = 'Sonos request failed') {
    super(message)
    this.name = 'SonosUpstreamError'
  }
}
