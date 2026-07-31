import { randomBytes } from 'node:crypto'
import type { AbsClient } from '../abs/client.js'
import { UnknownTokenError, UpstreamSessionLostError } from './errors.js'
import type { SessionEntry, SessionStore } from './sessionStore.js'

// The Audiobookshelf identity a sign-in resolved to, and the credential minted to stand in for it.
// Deliberately not the contract's AuthSession: what a major puts on the wire is api/'s business
// (contractMapping.ts), and this layer must not import a contract type to say what it produced.
export interface DeviceSession {
  token: string
  user: { id: string; username: string }
}

// 256 bits, as ADR-0001 requires: the token never expires and is never rotated, so its whole
// defence against guessing is entropy. base64url keeps it safe to carry in an Authorization
// header and in a JSON body without escaping.
const TOKEN_BYTES = 32

// The Ratatoskr-native session model's behaviour (SPEC section 8 / ADR-0001, ADR-0004): what a
// sign-in creates, what a sign-out destroys, and what a bearer resolves to. On top of the store's
// per-user shared chain: one ABS chain serves every device of a user, so a sign-in reuses (or heals)
// the user's chain rather than opening a second one, and a sign-out ends the ABS session upstream
// only when the last device of the user goes.
//
// The asymmetry worth naming: `signIn` returns a DeviceSession, which cannot carry a chain at all,
// while `resolve` returns the stored entry, which does - the caller needs the chain, since acting
// on it is the point. So the chain is confined by *who calls resolve*, not by this type: only the
// token guard does, and what it takes from the entry is the access token for upstream calls
// (api/app.ts). Anything mapped onto a response goes through DeviceSession instead.
export class AuthService {
  constructor(
    private readonly abs: AbsClient,
    private readonly store: SessionStore,
  ) {}

  // Sign in: prove the credentials against Audiobookshelf - which always opens a private chain for
  // this login - and mint the token that stands in for it from here on. The password is used for
  // that one call and then dropped; it is stored nowhere, on either side.
  //
  // The chain ABS just minted is kept only when the user had no live chain: a first sign-in installs
  // it, and a sign-in after the chain died heals it and retires the user's *other* device rows
  // (ADR-0004), so a bearer that rode the dead chain is not silently re-armed - each such device
  // re-authenticates once. When the user already has a live chain, that one is kept and the freshly
  // minted chain is a throwaway - best-effort ended upstream, so no idle ABS session is left behind.
  // Ending it is best-effort because the new token is already live by then: failing the sign-in over
  // an orphaned upstream session would hand the caller an error for a token that in fact works.
  //
  // `replacing` is the caller's previous token, if it still has one. A device re-authenticating gets
  // a wholly new session rather than a repaired one (SPEC section 8), so the old entry is signed out
  // full-depth once the new one exists - never before, or a rejected password would sign the device
  // out of a session that was still working. Best-effort for the same reason ending the throwaway is.
  async signIn(username: string, password: string, replacing?: string): Promise<DeviceSession> {
    const upstream = await this.abs.login(username, password)
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const chain = { accessToken: upstream.accessToken, refreshToken: upstream.refreshToken }
    const { usedFreshChain } = await this.store.attach(token, {
      absUserId: upstream.user.id,
      absUsername: upstream.user.username,
      chain,
    })
    if (!usedFreshChain) {
      // The user already had a live chain; this login's chain is a throwaway ABS session to end.
      try {
        await this.abs.logout(chain)
      } catch {
        // best-effort: the new token is live regardless, and an orphaned ABS session expires on its
        // own once nobody refreshes it.
      }
    }
    if (replacing !== undefined) {
      try {
        await this.signOut(replacing)
      } catch {
        // The replaced session outlives its device - an orphan an operator can still revoke, which
        // is the better of the two outcomes.
      }
    }
    return { token, user: upstream.user }
  }

  // Sign out: the device entry goes first, so the token is dead the moment this returns even if the
  // upstream call below hangs or fails. The Audiobookshelf chain is ended only when this was the
  // user's *last* device - while another device still rides the chain, ending it would sign that
  // device out too (ADR-0004), so the store hands back `endedChain` exactly when there is nothing
  // left to keep it alive. Ending it is best-effort by design: an orphaned upstream session expires
  // on its own once nobody refreshes it, and the commonest reason for a failure here is a chain that
  // is already dead. A store write that fails, in contrast, propagates: the token would still be
  // live, and answering "signed out" then is a lie.
  async signOut(token: string): Promise<void> {
    const { removed, endedChain } = await this.store.delete(token)
    if (!removed || endedChain === undefined) return
    try {
      await this.abs.logout(endedChain)
    } catch {
      // best-effort (SPEC section 8): sign-out still succeeds.
    }
  }

  // The token guard's lookup: in-process, no Audiobookshelf roundtrip (SPEC section 8). The entry
  // it returns carries the chain every upstream call for this caller then runs on.
  //
  // The two ways this fails are deliberately different errors, because the client's reactions to
  // them are opposite: an unknown token means signed out, while a token whose chain the keep-alive
  // loop marked dead means "your password, please" - the entry is still here precisely so this can
  // be told apart (SPEC section 8).
  resolve(token: string): SessionEntry {
    const entry = this.store.find(token)
    if (entry === undefined) throw new UnknownTokenError()
    if (entry.deadSince !== undefined) throw new UpstreamSessionLostError()
    return entry
  }
}
