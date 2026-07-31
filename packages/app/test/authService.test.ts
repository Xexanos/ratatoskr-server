import { describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'
import { AuthService } from '../src/auth/authService.js'
import { UnknownTokenError, UpstreamSessionLostError } from '../src/auth/errors.js'
import type { SessionStore } from '../src/auth/sessionStore.js'
import { tempSessionStore } from './helpers/tempSessionStore.js'

// The Ratatoskr-native session model (SPEC section 8 / ADR-0001, ADR-0004) as behaviour: what a
// sign-in creates, what a sign-out destroys, and what a bearer resolves to. The store is the real
// one on a temp file - the property under test is precisely that only the token's hash is persisted,
// and that a user's devices share one chain, which a fake store would have to re-implement to be
// worth anything.

const LISTENER = { id: 'usr-1', username: 'listener' }
const OTHER_USER = { id: 'usr-2', username: 'other' }
// The chain a user's first sign-in installs, and the throwaway a later sign-in of a user who already
// has a live chain mints and then ends upstream.
const CHAIN = { accessToken: 'abs-access', refreshToken: 'abs-refresh' }
const THROWAWAY = { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' }

function fakeAbs(overrides: Partial<AbsClient> = {}): AbsClient {
  return {
    login: vi.fn(async () => ({ ...CHAIN, user: LISTENER })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AbsClient
}

async function build(abs: AbsClient = fakeAbs()): Promise<{ auth: AuthService; store: SessionStore; abs: AbsClient }> {
  const store = await tempSessionStore()
  return { auth: new AuthService(abs, store), store, abs }
}

describe('AuthService.signIn', () => {
  it('validates against ABS and returns a token plus the identified user', async () => {
    const { auth, abs } = await build()

    const session = await auth.signIn('listener', 's3cret')

    expect(abs.login).toHaveBeenCalledWith('listener', 's3cret')
    expect(session.user).toEqual(LISTENER)
    expect(session.token).toEqual(expect.any(String))
  })

  // 256 bits, as ADR-0001 requires: the token never expires and is never rotated, so entropy is
  // its whole defence against guessing.
  it('mints an opaque 256-bit token, different every time', async () => {
    const { auth } = await build()

    const first = await auth.signIn('listener', 's3cret')
    const second = await auth.signIn('listener', 's3cret')

    expect(first.token).not.toBe(second.token)
    // base64url of 32 bytes: 43 chars, and nothing needing escaping in a header or a JSON body.
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  // The central security property of the whole model: even a full store + key leak cannot
  // reproduce the credential the device holds.
  it('never persists the token itself, only its hash', async () => {
    const { auth, store } = await build()

    const { token } = await auth.signIn('listener', 's3cret')

    expect(store.list()).toHaveLength(1)
    expect(JSON.stringify(store.list())).not.toContain(token)
    expect(store.find(token)).toBeDefined()
  })

  it('stores the ABS chain and the identity the keep-alive path needs', async () => {
    const { auth, store } = await build()

    const { token } = await auth.signIn('listener', 's3cret')

    expect(store.find(token)).toMatchObject({ absUserId: 'usr-1', absUsername: 'listener', chain: CHAIN })
  })

  // ADR-0004: a user's devices share one chain. The second sign-in keeps the chain already there and
  // ends the throwaway ABS session it just minted, so there is only ever one chain per user - and
  // signing in on one device still never signs the other out.
  it('gives each device its own entry on the one shared chain', async () => {
    const { auth, store, abs } = await build()

    const phone = await auth.signIn('listener', 's3cret')
    vi.mocked(abs.login).mockResolvedValueOnce({ ...THROWAWAY, user: LISTENER })
    const tablet = await auth.signIn('listener', 's3cret')

    expect(store.list()).toHaveLength(2)
    // Both ride the chain the first sign-in installed; the second's throwaway was ended upstream.
    expect(store.find(phone.token)?.chain).toEqual(CHAIN)
    expect(store.find(tablet.token)?.chain).toEqual(CHAIN)
    expect(abs.logout).toHaveBeenCalledWith(THROWAWAY)
  })

  it('rejects bad credentials without creating anything', async () => {
    const abs = fakeAbs({
      login: vi.fn(async () => {
        throw new AbsAuthError()
      }) as unknown as AbsClient['login'],
    })
    const { auth, store } = await build(abs)

    await expect(auth.signIn('listener', 'wrong')).rejects.toBeInstanceOf(AbsAuthError)
    expect(store.list()).toHaveLength(0)
  })

  // A device re-authenticating gets a wholly new token (SPEC section 8), and the one it replaces is
  // retired - but only once the new one exists. The user's live chain is kept across the re-login;
  // it is the freshly minted throwaway that is ended upstream (ADR-0004).
  it('retires the token being replaced and keeps the user’s live chain, ending the throwaway', async () => {
    const { auth, store, abs } = await build()
    const old = await auth.signIn('listener', 's3cret')
    vi.mocked(abs.login).mockResolvedValueOnce({ ...THROWAWAY, user: LISTENER })

    const fresh = await auth.signIn('listener', 's3cret', old.token)

    expect(store.find(old.token)).toBeUndefined()
    expect(store.find(fresh.token)?.chain).toEqual(CHAIN)
    expect(abs.logout).toHaveBeenCalledWith(THROWAWAY)
  })

  it('keeps the old session when the new password is rejected', async () => {
    const failing = vi.fn(async () => ({ ...CHAIN, user: LISTENER }))
    const abs = fakeAbs({ login: failing as unknown as AbsClient['login'] })
    const { auth, store } = await build(abs)
    const old = await auth.signIn('listener', 's3cret')
    failing.mockRejectedValueOnce(new AbsAuthError())

    await expect(auth.signIn('listener', 'wrong', old.token)).rejects.toBeInstanceOf(AbsAuthError)

    // Signing the device out on a typo would be the worst possible reading of a failed re-login.
    expect(store.find(old.token)).toBeDefined()
  })

  it('still returns the new session when ending the throwaway fails', async () => {
    const abs = fakeAbs({
      logout: vi.fn(async () => {
        throw new AbsUpstreamError('ABS is down')
      }) as unknown as AbsClient['logout'],
    })
    const { auth, store } = await build(abs)
    const old = await auth.signIn('listener', 's3cret')

    const fresh = await auth.signIn('listener', 's3cret', old.token)

    // The new token is already live, so failing the sign-in here would hand the caller an error
    // for a token that in fact works - and lose it.
    expect(store.find(fresh.token)).toBeDefined()
  })

  // Healing a dead chain retires the user's *other* devices rather than reviving them (ADR-0004):
  // a stale bearer riding the dead chain must not be re-armed by the owner's next sign-in, or an
  // upstream revocation (or password change) that killed the chain would be silently undone. Each
  // such device re-authenticates once - ADR-0001's accepted post-outage UX.
  it('retires the user’s other devices when a sign-in heals their dead chain', async () => {
    const { auth, store, abs } = await build()
    const stranded = await auth.signIn('listener', 's3cret')
    await store.markDead(store.find(stranded.token)!)
    vi.mocked(abs.login).mockResolvedValueOnce({ ...THROWAWAY, user: LISTENER })

    const fresh = await auth.signIn('listener', 's3cret')

    // Only the re-authenticating device survives, on the healed chain; the stranded one is gone.
    expect(store.find(stranded.token)).toBeUndefined()
    expect(store.find(fresh.token)?.chain).toEqual(THROWAWAY)
    expect(store.find(fresh.token)?.deadSince).toBeUndefined()
    expect(store.list()).toHaveLength(1)
    // The healing chain is the user's chain now, not a throwaway - nothing to end upstream.
    expect(abs.logout).not.toHaveBeenCalled()
  })

  // A live sibling is left alone: retiring on heal fires only when the chain had actually died, so a
  // second sign-in onto a live chain never disturbs the devices already on it.
  it('leaves the user’s live devices alone on an ordinary second sign-in', async () => {
    const { auth, store, abs } = await build()
    const tablet = await auth.signIn('listener', 's3cret')
    vi.mocked(abs.login).mockResolvedValueOnce({ ...THROWAWAY, user: LISTENER })

    await auth.signIn('listener', 's3cret')

    expect(store.find(tablet.token)).toBeDefined()
    expect(store.list()).toHaveLength(2)
  })

  it('leaves another ABS user’s dead chain alone', async () => {
    const { auth, store, abs } = await build()
    vi.mocked(abs.login).mockResolvedValueOnce({ ...CHAIN, user: OTHER_USER })
    const other = await auth.signIn('other', 's3cret')
    await store.markDead(store.find(other.token)!)

    await auth.signIn('listener', 's3cret')

    expect(store.find(other.token)?.deadSince).toEqual(expect.any(String))
  })

  it('ignores a replaced token it does not know', async () => {
    const { auth, abs } = await build()

    const fresh = await auth.signIn('listener', 's3cret', 'never-issued')

    expect(fresh.token).toEqual(expect.any(String))
    expect(abs.logout).not.toHaveBeenCalled()
  })
})

describe('AuthService.signOut', () => {
  it('kills the token immediately and ends a solo device’s chain upstream', async () => {
    const { auth, store, abs } = await build()
    const { token } = await auth.signIn('listener', 's3cret')

    await auth.signOut(token)

    expect(store.find(token)).toBeUndefined()
    expect(abs.logout).toHaveBeenCalledWith(CHAIN)
  })

  // Signing out one device of a user leaves the shared chain alive for the others - so it must not
  // be ended upstream while another device still rides it (ADR-0004).
  it('leaves other devices signed in and their shared chain untouched upstream', async () => {
    const { auth, store, abs } = await build()
    const phone = await auth.signIn('listener', 's3cret')
    const tablet = await auth.signIn('listener', 's3cret')
    vi.mocked(abs.logout).mockClear()

    await auth.signOut(phone.token)

    expect(store.find(tablet.token)).toBeDefined()
    expect(abs.logout).not.toHaveBeenCalled()
  })

  // Idempotent and best-effort, so a client can always complete a sign-out locally (contract).
  it('is a no-op for a token it does not know', async () => {
    const { auth, abs } = await build()

    await expect(auth.signOut('never-issued')).resolves.toBeUndefined()
    expect(abs.logout).not.toHaveBeenCalled()
  })

  it('succeeds even when ABS is unreachable', async () => {
    const abs = fakeAbs({
      logout: vi.fn(async () => {
        throw new AbsUpstreamError('ABS is down')
      }) as unknown as AbsClient['logout'],
    })
    const { auth, store } = await build(abs)
    const { token } = await auth.signIn('listener', 's3cret')

    await expect(auth.signOut(token)).resolves.toBeUndefined()
    // An orphaned upstream session expires on its own once nobody refreshes it; the local entry
    // going is what the client was promised.
    expect(store.find(token)).toBeUndefined()
  })

  // The one failure that must NOT be swallowed: if the entry survives, the token is still live and
  // answering "signed out" would be a lie.
  it('propagates a failed store write instead of claiming the token is dead', async () => {
    const { auth, store } = await build()
    const { token } = await auth.signIn('listener', 's3cret')
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('disk full'))

    await expect(auth.signOut(token)).rejects.toThrow('disk full')
  })
})

describe('AuthService.resolve', () => {
  it('resolves a live token to the entry carrying its chain', async () => {
    const { auth } = await build()
    const { token } = await auth.signIn('listener', 's3cret')

    expect(auth.resolve(token)).toMatchObject({ absUsername: 'listener', chain: CHAIN })
  })

  it('rejects a token it never issued', async () => {
    const { auth } = await build()

    expect(() => auth.resolve('never-issued')).toThrow(UnknownTokenError)
  })

  it('rejects a token that has been signed out', async () => {
    const { auth } = await build()
    const { token } = await auth.signIn('listener', 's3cret')
    await auth.signOut(token)

    expect(() => auth.resolve(token)).toThrow(UnknownTokenError)
  })

  // The whole point of keeping a dead chain's devices (SPEC section 8): this token is not unknown,
  // and telling its device "signed out" would send it to a full sign-in when a password prompt is
  // what the situation calls for.
  it('reports a dead chain as a lost upstream session, not as an unknown token', async () => {
    const { auth, store } = await build()
    const { token } = await auth.signIn('listener', 's3cret')
    await store.markDead(store.find(token)!)

    expect(() => auth.resolve(token)).toThrow(UpstreamSessionLostError)
  })

  // An ABS access token is not a Ratatoskr token: the two namespaces are disjoint, which is what
  // stops a /v1-era credential from being replayed against /v2.
  it('rejects the ABS access token behind a live session', async () => {
    const { auth } = await build()
    await auth.signIn('listener', 's3cret')

    expect(() => auth.resolve(CHAIN.accessToken)).toThrow(UnknownTokenError)
  })
})
