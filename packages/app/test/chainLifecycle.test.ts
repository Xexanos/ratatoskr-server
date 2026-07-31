import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
import type { SessionStore } from '../src/auth/sessionStore.js'
import type { SonosClient } from '../src/sonos/client.js'
import { buildTestApp, DEVICE_USER, V2_AUTH } from './helpers/testApp.js'
import { tempSessionStore } from './helpers/tempSessionStore.js'

// What a stored chain's life and death look like from outside, through real /v2 routes: the request
// path renews an access token that ran out while nobody was listening, and a chain that died anyway
// answers with the one 401 that asks for a password instead of the one that means "signed out"
// (SPEC section 8). The loop itself is a unit elsewhere (keepAlive.test.ts) — what only a route test
// shows is that the guard, the error mapping and the contract line up behind it.

const DEVICE_TOKEN = 'rtk-device-token'
const RENEWED = { accessToken: 'abs-access-renewed', refreshToken: 'abs-refresh-renewed' }
const BOOKS = { books: [], nextCursor: null }

// An access token shaped like the JWT Audiobookshelf issues. A negative lifetime is the pause this
// whole mechanism exists for: the device came back after the token behind it had expired.
function accessToken(inSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + inSeconds })).toString('base64url')
  return `header.${payload}.signature`
}

async function signedInWith(chain: { accessToken: string; refreshToken: string }): Promise<SessionStore> {
  const store = await tempSessionStore()
  await store.create(DEVICE_TOKEN, { ...DEVICE_USER, chain })
  return store
}

function appWith(store: SessionStore, abs: Partial<AbsClient> = {}) {
  return buildTestApp(
    {
      absClient: {
        listItems: vi.fn().mockResolvedValue(BOOKS),
        refresh: vi.fn().mockResolvedValue({ ...RENEWED, user: { id: DEVICE_USER.absUserId, username: 'listener' } }),
        login: vi.fn().mockResolvedValue({ ...RENEWED, user: { id: DEVICE_USER.absUserId, username: 'listener' } }),
        logout: vi.fn().mockResolvedValue(undefined),
        ...abs,
      } as unknown as AbsClient,
      sonosClient: {} as SonosClient,
      sessionStore: store,
    },
    { signedIn: false },
  )
}

afterEach(() => vi.restoreAllMocks())

describe('a chain whose access token expired while nobody was listening', () => {
  it('is renewed before the handler runs, and the handler acts on the new token', async () => {
    const store = await signedInWith({ accessToken: accessToken(-60), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store)

    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(res.statusCode).toBe(200)
    // Persisted, not just used for this request: the next one starts from the renewed chain, and so
    // does the next boot.
    expect(store.find(DEVICE_TOKEN)?.chain).toEqual(RENEWED)
    await app.close()
  })

  it('forwards the renewed access token upstream, never the one that expired', async () => {
    const listItems = vi.fn().mockResolvedValue(BOOKS)
    const store = await signedInWith({ accessToken: accessToken(-60), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store, { listItems })

    await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(listItems).toHaveBeenCalledWith(RENEWED.accessToken, expect.anything())
    await app.close()
  })

  // The refresh window has run out (or the account was renamed): the chain is gone, and this is the
  // request that finds out. The device keeps its token and is told to re-authenticate.
  it('answers UPSTREAM_SESSION_LOST when the renewal proves the chain gone', async () => {
    const refresh = vi.fn().mockRejectedValue(new AbsAuthError())
    const store = await signedInWith({ accessToken: accessToken(-60), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store, { refresh })

    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UPSTREAM_SESSION_LOST')
    expect(store.find(DEVICE_TOKEN)?.deadSince).toEqual(expect.any(String))
    await app.close()
  })
})

describe('a live chain the upstream revoked before its access token neared expiry', () => {
  // The token is nowhere near expiry, so usableChain hands back the stored chain without refreshing:
  // the proxied ABS call is what discovers the revocation. Its 401 must not read as "signed out" —
  // the token is known and its entry live — but as the lost-session 401 that asks for a password
  // (#163, SPEC section 8), the same one a chain the sweep proved dead already answers.
  it('answers UPSTREAM_SESSION_LOST rather than a generic unauthorized', async () => {
    const listItems = vi.fn().mockRejectedValue(new AbsAuthError())
    const refresh = vi.fn()
    const store = await signedInWith({ accessToken: accessToken(3600), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store, { listItems, refresh })

    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UPSTREAM_SESSION_LOST')
    // The proxied call proved the chain dead: nothing was refreshed ahead of it, since the token was
    // not near expiry — this is the "revoked before expiry" path, not the refresh-proved-dead one.
    expect(refresh).not.toHaveBeenCalled()
    await app.close()
  })

  // The entry is buried on the spot, not left live-looking until the next keep-alive sweep proves it:
  // the next request is answered from the dead chain, without reaching upstream again.
  it('marks the chain dead, so the next request needs no upstream call to say so', async () => {
    const listItems = vi.fn().mockRejectedValue(new AbsAuthError())
    const store = await signedInWith({ accessToken: accessToken(3600), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store, { listItems })

    await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })
    expect(store.find(DEVICE_TOKEN)?.deadSince).toEqual(expect.any(String))

    listItems.mockClear()
    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UPSTREAM_SESSION_LOST')
    expect(listItems).not.toHaveBeenCalled()
    await app.close()
  })

  // The remapping is confined to a call made on a resolved device session. A wrong-password
  // re-authentication is unauthenticated (login carries `security: []`, so no Ratatoskr token is
  // resolved) even when the device offers its old bearer — its 401 is a genuine credential rejection
  // and must not be mistaken for the live chain going dead.
  it('leaves a bad-password re-login as a genuine unauthorized, sparing the still-live chain', async () => {
    const login = vi.fn().mockRejectedValue(new AbsAuthError())
    const store = await signedInWith({ accessToken: accessToken(3600), refreshToken: 'abs-refresh-1' })
    const { app } = await appWith(store, { login })

    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      headers: V2_AUTH,
      payload: { username: 'listener', password: 'wrong' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(store.find(DEVICE_TOKEN)?.deadSince).toBeUndefined()
    await app.close()
  })
})

describe('a chain the keep-alive loop has already marked dead', () => {
  async function deadDevice(): Promise<SessionStore> {
    const store = await signedInWith({ accessToken: accessToken(3600), refreshToken: 'abs-refresh-1' })
    await store.markDead(store.find(DEVICE_TOKEN)!)
    return store
  }

  // The distinction the whole entry is kept for: this must not read as "signed out", or the app
  // throws away state it could keep and asks for a full sign-in instead of a password.
  it('answers 401 UPSTREAM_SESSION_LOST rather than a generic unauthorized', async () => {
    const store = await deadDevice()
    const { app } = await appWith(store)

    const res = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UPSTREAM_SESSION_LOST')
    await app.close()
  })

  it('reaches nothing upstream on the way to saying so', async () => {
    const listItems = vi.fn().mockResolvedValue(BOOKS)
    const refresh = vi.fn()
    const store = await deadDevice()
    const { app } = await appWith(store, { listItems, refresh })

    await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })

    expect(listItems).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    await app.close()
  })

  // Sign-out is idempotent by contract, and a device with a dead chain has all the more reason to
  // complete one — it is the tidy half of the re-authentication it is about to do.
  it('can still be signed out', async () => {
    const store = await deadDevice()
    const { app } = await appWith(store)

    const res = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    await app.close()
  })

  // A re-login of the same user heals the dead chain, but retires the user's other devices rather
  // than reviving them (ADR-0004): a stale bearer that rode the dead chain must not be re-armed, or
  // the upstream revocation that killed the chain would be undone. The stranded device re-reads as
  // signed out and re-authenticates on its own.
  it('retires the user’s other devices when a re-login heals the chain', async () => {
    const store = await deadDevice()
    const { app } = await appWith(store)

    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { username: 'listener', password: 's3cret' },
    })
    expect(res.statusCode).toBe(200)
    const fresh = res.json().token as string

    // The stranded device is gone, and its old bearer now reads as signed out (not the lost-session
    // 401), so its device shows the sign-in screen rather than a password prompt.
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    const stale = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })
    expect(stale.statusCode).toBe(401)
    expect(stale.json().code).toBe('unauthorized')

    // Only the re-authenticated device remains, on the one healed chain.
    const usable = await app.inject({ method: 'GET', url: '/v2/library/items', headers: { authorization: `Bearer ${fresh}` } })
    expect(usable.statusCode).toBe(200)
    expect(store.list()).toHaveLength(1)
    expect(store.listChains()).toHaveLength(1)
    await app.close()
  })
})
