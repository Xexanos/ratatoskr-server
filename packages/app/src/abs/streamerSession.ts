import type { AbsClient } from './client.js'

// The dedicated streamer identity (SPEC section 14). Its short-lived access token is what goes
// into the media URLs handed to the speakers — never the listening user's token — because those
// URLs are readable by anyone on the LAN. This holder logs the low-privilege streamer account in
// and keeps its current access token in memory; `refresh()` re-logs in when the token nears/So
// passes expiry (a full re-login is fine — the account is dedicated and the token is short-lived).
export class StreamerSession {
  private accessToken: string | undefined

  constructor(
    private readonly abs: AbsClient,
    private readonly username: string,
    private readonly password: string,
  ) {}

  // Log the streamer in. Called once at startup (main.ts) so a bad streamer credential fails loud
  // there rather than on the first playback. Throws AbsAuthError/AbsUpstreamError from AbsClient.
  async login(): Promise<void> {
    const tokens = await this.abs.login(this.username, this.password)
    this.accessToken = tokens.accessToken
  }

  // The current streamer access token to embed in media URLs. Throws if not logged in yet.
  currentToken(): string {
    if (this.accessToken === undefined) {
      throw new Error('Streamer session is not logged in')
    }
    return this.accessToken
  }

  // Re-acquire a fresh streamer token (used when the current one is about to expire during long
  // playback). Returns the new token.
  async refresh(): Promise<string> {
    await this.login()
    return this.currentToken()
  }
}
