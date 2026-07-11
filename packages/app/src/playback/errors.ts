// Errors from the playback session manager. The API layer maps these to contract responses:
// NoActiveSessionError -> 404 (NoActiveSession). ItemNotPlayableError (from abs/) -> 400.

export class NoActiveSessionError extends Error {
  constructor(message = 'No audiobook is currently playing') {
    super(message)
    this.name = 'NoActiveSessionError'
  }
}
