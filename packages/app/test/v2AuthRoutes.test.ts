import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'
import { SessionStore } from '../src/auth/sessionStore.js'
import type { SonosClient } from '../src/sonos/client.js'
import { ABS_CHAIN, buildTestApp, DEVICE_TOKEN, V2_AUTH } from './helpers/testApp.js'

// The /v2 auth surface through real routes: what a client sends, what it gets back, and what reaches
// Audiobookshelf. The service and store are covered as units elsewhere (authService.test.ts) — what
// only a route test can show is that the wiring puts the right handler behind the right mount, with
// the security handler and token guard in front of it.

const UPSTREAM = {
  accessToken: 'abs-access-token',
  refreshToken: 'abs-refresh-token',
  user: { id: 'usr-1', username: 'listener' },
}
const CREDENTIALS = { username: 'listener', password: 's3cret' }

function appWith(abs: Partial<AbsClient> = {}, { store, ...options }: { signedIn?: boolean; store?: SessionStore } = {}) {
  return buildTestApp(
    {
      absClient: { login: vi.fn().mockResolvedValue(UPSTREAM), logout: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
      sonosClient: {} as SonosClient,
      ...(store !== undefined ? { sessionStore: store } : {}),
    },
    options,
  )
}

describe('POST /v2/auth/login', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns an AuthSession and stores only the token hash', async () => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: expect.any(String), user: UPSTREAM.user })
    // The credential the client now holds resolves, and the file holds no copy of it.
    const token = res.json().token as string
    expect(store.find(token)).toBeDefined()
    expect(JSON.stringify(store.list())).not.toContain(token)
    await app.close()
  })

  it('keeps the ABS chain server-side, out of the response', async () => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.body).not.toContain(UPSTREAM.accessToken)
    expect(res.body).not.toContain(UPSTREAM.refreshToken)
    // Held, not discarded — it is what the caller's later requests will run on.
    expect(store.find(res.json().token as string)?.chain).toEqual({
      accessToken: UPSTREAM.accessToken,
      refreshToken: UPSTREAM.refreshToken,
    })
    await app.close()
  })

  it('never puts the password anywhere', async () => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.body).not.toContain(CREDENTIALS.password)
    expect(JSON.stringify(store.list())).not.toContain(CREDENTIALS.password)
    await app.close()
  })

  it('maps rejected credentials to 401 and creates no session', async () => {
    const login = vi.fn().mockRejectedValue(new AbsAuthError())
    const { app, store } = await appWith({ login }, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: { ...CREDENTIALS, password: 'wrong' } })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(store.list()).toHaveLength(0)
    await app.close()
  })

  it('maps an unreachable Audiobookshelf to 502', async () => {
    const login = vi.fn().mockRejectedValue(new AbsUpstreamError('ABS is down'))
    const { app } = await appWith({ login }, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('upstream_error')
    await app.close()
  })

  it('rejects a body without a password as 400, before reaching ABS', async () => {
    const login = vi.fn()
    const { app } = await appWith({ login }, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: { username: 'listener' } })

    expect(res.statusCode).toBe(400)
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })

  // Sign-in is unauthenticated, so a bearer is read rather than required — this is the whole
  // mechanism by which a re-login retires the session it replaces (SPEC section 8). The user's live
  // chain is kept across the re-login; the freshly minted throwaway ABS session is the one ended
  // upstream (ADR-0004).
  it('signs the offered previous token out once the new session exists', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })

    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', headers: V2_AUTH, payload: CREDENTIALS })

    expect(res.statusCode).toBe(200)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    // The new session rides the chain that was already there, not the throwaway.
    expect(store.find(res.json().token as string)?.chain).toEqual(ABS_CHAIN)
    // Exactly one session, and the throwaway ABS session was ended upstream rather than orphaned.
    expect(store.list()).toHaveLength(1)
    expect(logout).toHaveBeenCalledWith({ accessToken: UPSTREAM.accessToken, refreshToken: UPSTREAM.refreshToken })
    await app.close()
  })

  it('succeeds without a bearer — the ordinary first sign-in', async () => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.statusCode).toBe(200)
    expect(store.list()).toHaveLength(1)
    await app.close()
  })

  // A stale or malformed bearer must not turn a valid sign-in into a 401: the caller is trying to
  // discard that credential, which is the one situation where it certainly no longer matters.
  it.each([
    ['an unknown token', { authorization: 'Bearer never-issued' }],
    ['a malformed header', { authorization: 'Basic whatever' }],
  ])('ignores %s and still signs in', async (_case, headers) => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', headers, payload: CREDENTIALS })

    expect(res.statusCode).toBe(200)
    expect(store.list()).toHaveLength(1)
    await app.close()
  })

  // Two devices, one ABS user: the contract promises signing in on one never signs the other out.
  it('leaves another device signed in', async () => {
    const { app, store } = await appWith()
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })

    expect(res.statusCode).toBe(200)
    expect(store.find(DEVICE_TOKEN)).toBeDefined()
    expect(store.list()).toHaveLength(2)
    await app.close()
  })
})

describe('POST /v2/auth/logout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns 204, kills the token, and ends the chain upstream', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    expect(logout).toHaveBeenCalledWith(ABS_CHAIN)
    await app.close()
  })

  it('makes the token unusable immediately', async () => {
    const { app } = await appWith({ listItems: vi.fn().mockResolvedValue({ books: [], nextCursor: null }) })
    await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    const after = await app.inject({ method: 'GET', url: '/v2/library/items', headers: V2_AUTH })
    expect(after.statusCode).toBe(401)
    await app.close()
  })

  // Idempotent and best-effort, so a client can always complete a sign-out locally (contract).
  it('answers 204 for a token this server never issued', async () => {
    const logout = vi.fn()
    const { app } = await appWith({ logout }, { signedIn: false })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/logout',
      headers: { authorization: 'Bearer never-issued' },
    })

    expect(res.statusCode).toBe(204)
    expect(logout).not.toHaveBeenCalled()
    await app.close()
  })

  it('answers 204 twice for the same token', async () => {
    const { app } = await appWith()
    const first = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })
    const second = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    expect(first.statusCode).toBe(204)
    expect(second.statusCode).toBe(204)
    await app.close()
  })

  it('answers 204 when Audiobookshelf is unreachable', async () => {
    const logout = vi.fn().mockRejectedValue(new AbsUpstreamError('ABS is down'))
    const { app, store } = await appWith({ logout })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    // The local entry is gone regardless; an orphaned ABS session expires once nobody refreshes it.
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    await app.close()
  })

  // The one 401 the operation has: no bearer at all. That is the security handler's doing, and it
  // still applies to an operation the token guard lets past.
  it('rejects a request with no bearer as 401', async () => {
    const { app, store } = await appWith()
    const res = await app.inject({ method: 'POST', url: '/v2/auth/logout' })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    expect(store.find(DEVICE_TOKEN)).toBeDefined()
    await app.close()
  })

  it('leaves another device signed in', async () => {
    const { app, store } = await appWith()
    await store.create('other-device', { absUserId: 'usr-1', absUsername: 'listener', chain: ABS_CHAIN })

    await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: V2_AUTH })

    expect(store.find('other-device')).toBeDefined()
    await app.close()
  })
})

// The round trip a client actually makes, through real routes: sign in, use the token, sign out.
describe('the /v2 session lifecycle end to end', () => {
  afterEach(() => vi.restoreAllMocks())

  it('signs in, uses the minted token upstream on the session chain, and signs out', async () => {
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })
    const { app, store } = await appWith({ listItems }, { signedIn: false })

    const login = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })
    const token = login.json().token as string

    const list = await app.inject({ method: 'GET', url: '/v2/library/items', headers: { authorization: `Bearer ${token}` } })
    expect(list.statusCode).toBe(200)
    // What went upstream is the chain from the sign-in, never the token the client holds.
    expect(listItems).toHaveBeenCalledWith(UPSTREAM.accessToken, expect.anything())

    const out = await app.inject({ method: 'POST', url: '/v2/auth/logout', headers: { authorization: `Bearer ${token}` } })
    expect(out.statusCode).toBe(204)
    expect(store.list()).toHaveLength(0)
    await app.close()
  })

  // The hard requirement the store exists for (SPEC section 8): a restart must not sign anyone out.
  // Two SessionStore instances over one file, which is what a restarted process actually has — not
  // one store object reused, which would prove only that a Map survives.
  it('keeps a device signed in across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rtk-restart-'))
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true })
    })
    const storeOptions = { path: join(dir, 'sessions.enc'), key: Buffer.alloc(32, 0x33) }
    const listItems = vi.fn().mockResolvedValue({ books: [], nextCursor: null })

    const { app: first } = await appWith({ listItems }, { store: await SessionStore.open(storeOptions), signedIn: false })
    const login = await first.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })
    const token = login.json().token as string
    await first.close()

    const { app: second } = await appWith({ listItems }, { store: await SessionStore.open(storeOptions), signedIn: false })
    const res = await second.inject({
      method: 'GET',
      url: '/v2/library/items',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    await second.close()
  })
})
