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

// The Ratatoskr-native session model's behaviour (SPEC section 8), on top of the store's
// persistence: what a sign-in creates, what a sign-out destroys, and what a bearer resolves to.
//
// The asymmetry worth naming: `signIn` returns a DeviceSession, which cannot carry a chain at all,
// while `resolve` returns the stored entry, which does — the caller needs the chain, since acting
// on it is the point. So the chain is confined by *who calls resolve*, not by this type: only the
// token guard does, and what it takes from the entry is the access token for upstream calls
// (api/app.ts). Anything mapped onto a response goes through DeviceSession instead.
export class AuthService {
  constructor(
    private readonly abs: AbsClient,
    private readonly store: SessionStore,
  ) {}

  // Sign in: prove the credentials against Audiobookshelf — which opens a private chain for this
  // device — and mint the token that stands in for it from here on. The password is used for that
  // one call and then dropped; it is stored nowhere, on either side.
  //
  // `replacing` is the caller's previous token, if it still has one. A device re-authenticating
  // after its chain died gets a wholly new session rather than a repaired one (SPEC section 8), so
  // the old entry is signed out full-depth once the new one exists — never before, or a rejected
  // password would sign the device out of a session that was still working. Retiring it is
  // best-effort for the same reason: the new token is already live by then, so failing the sign-in
  // over it would hand the caller an error for a token that in fact works, and lose it.
  async signIn(username: string, password: string, replacing?: string): Promise<DeviceSession> {
    const upstream = await this.abs.login(username, password)
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    await this.store.create(token, {
      absUserId: upstream.user.id,
      absUsername: upstream.user.username,
      chain: { accessToken: upstream.accessToken, refreshToken: upstream.refreshToken },
    })
    if (replacing !== undefined) {
      try {
        await this.signOut(replacing)
      } catch {
        // The replaced session outlives its device — an orphan an operator can still revoke, which
        // is the better of the two outcomes.
      }
    }
    await this.retireDeadSessions(upstream.user.id)
    return { token, user: upstream.user }
  }

  // The other half of "re-login deletes the old entry", and the half no client can do: a device
  // whose chain died before it could offer the token it is replacing leaves an entry nobody can
  // name — `POST /v2/auth/login` is unauthenticated, so the server cannot identify it either. Once
  // the keep-alive loop has marked that entry dead, this is what closes it: the same ABS user has
  // just proved the password, and a dead entry of theirs can only be the session they are replacing.
  //
  // Only the dead ones — another device of the same user is still listening on its own live chain.
  // Nothing goes upstream: the chain is gone, which is what "dead" records, so an ABS sign-out would
  // have nothing left to end. Best-effort, for the same reason retiring the offered token is: the
  // new token is already live, and failing the sign-in over a stale entry would lose it.
  private async retireDeadSessions(absUserId: string): Promise<void> {
    for (const entry of this.store.list()) {
      if (entry.absUserId !== absUserId || entry.deadSince === undefined) continue
      try {
        await this.store.remove(entry)
      } catch {
        // An entry that outlives this attempt stays dead, and the next sign-in tries again.
      }
    }
  }

  // Sign out: the entry goes first, so the token is dead the moment this returns even if the
  // upstream call below hangs or fails. Ending the Audiobookshelf chain is best-effort by design —
  // an orphaned upstream session expires on its own once nobody refreshes it, and the commonest
  // reason for a failure here is a chain that is already dead. A store write that fails, in
  // contrast, propagates: the token would still be live, and answering "signed out" then is a lie.
  async signOut(token: string): Promise<void> {
    const entry = this.store.find(token)
    if (entry === undefined) return
    if (!(await this.store.delete(token))) return
    try {
      await this.abs.logout(entry.chain)
    } catch {
      // best-effort (SPEC section 8): sign-out still succeeds.
    }
  }

  // The token guard's lookup: in-process, no Audiobookshelf roundtrip (SPEC section 8). The entry
  // it returns carries the chain every upstream call for this caller then runs on.
  //
  // The two ways this fails are deliberately different errors, because the client's reactions to
  // them are opposite: an unknown token means signed out, while a token whose chain the keep-alive
  // loop marked dead means "your password, please" — the entry is still here precisely so this can
  // be told apart (SPEC section 8).
  resolve(token: string): SessionEntry {
    const entry = this.store.find(token)
    if (entry === undefined) throw new UnknownTokenError()
    if (entry.deadSince !== undefined) throw new UpstreamSessionLostError()
    return entry
  }
}
